import { z } from "zod";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import {
  appointments,
  visitRecordingConsents,
  visitRecordings,
} from "@openpims/db";
import type { Database } from "@openpims/db/client";
import { createRouter, protectedProcedure, requireRole } from "../trpc";
import { isAgentConfigured } from "@/lib/agent";
import { lockOpenVisitForClinicalAppend } from "@/lib/records/visit-integrity";
import {
  lockPracticeForExternalSideEffects,
  RECOVERY_HOLD_BLOCK_MESSAGE,
} from "@/lib/recovery-hold";
import { consentIsActive } from "@/lib/visit-recordings/consent";
import {
  VISIT_RECORDING_DISCLOSURE,
  VISIT_RECORDING_DISCLOSURE_VERSION,
  VISIT_RECORDINGS_PER_APPOINTMENT_LIMIT,
} from "@/lib/visit-recordings/disclosure";
import {
  deleteVisitAudio,
  deleteVisitTranscriptionJob,
  pollVisitTranscription,
  visitRecordingTranscriptionConfigured,
} from "@/lib/visit-recordings/aws";

/** Staff who may ask for consent and run the recorder during a visit. */
const RECORDING_ROLES = ["admin", "veterinarian", "technician"] as const;

type RecordingContext = { db: Database; practiceId: string };

function visitGuardError(
  reason: "appointment_not_found" | "visit_not_open" | "visit_finalized",
): TRPCError {
  if (reason === "appointment_not_found") {
    return new TRPCError({ code: "NOT_FOUND", message: "Visit not found" });
  }
  return new TRPCError({
    code: "PRECONDITION_FAILED",
    message:
      reason === "visit_finalized"
        ? "This visit's records are finalized."
        : "Recordings can only be made while the visit is in exam.",
  });
}

async function latestConsent(ctx: RecordingContext, appointmentId: string) {
  const [consent] = await ctx.db
    .select({
      id: visitRecordingConsents.id,
      action: visitRecordingConsents.action,
      signerName: visitRecordingConsents.signerName,
      actorName: visitRecordingConsents.actorName,
      occurredAt: visitRecordingConsents.occurredAt,
    })
    .from(visitRecordingConsents)
    .where(
      and(
        eq(visitRecordingConsents.practiceId, ctx.practiceId),
        eq(visitRecordingConsents.appointmentId, appointmentId),
      ),
    )
    .orderBy(
      desc(visitRecordingConsents.occurredAt),
      desc(visitRecordingConsents.createdAt),
    )
    .limit(1);
  return consent ?? null;
}

async function lockRecording(ctx: RecordingContext, recordingId: string) {
  const [recording] = await ctx.db
    .select()
    .from(visitRecordings)
    .where(
      and(
        eq(visitRecordings.id, recordingId),
        eq(visitRecordings.practiceId, ctx.practiceId),
        isNull(visitRecordings.deletedAt),
      ),
    )
    .for("update");
  if (!recording) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Recording not found" });
  }
  return recording;
}

/** Best-effort audio removal; returns whether the object is gone. */
async function removeAudio(recording: {
  audioObjectKey: string | null;
  audioObjectVersionId: string | null;
  audioDeletedAt: Date | null;
}): Promise<boolean> {
  if (!recording.audioObjectKey || recording.audioDeletedAt) return true;
  try {
    await deleteVisitAudio({
      key: recording.audioObjectKey,
      versionId: recording.audioObjectVersionId,
    });
    return true;
  } catch {
    // The bucket lifecycle rule on visit-recordings/ is the backstop.
    return false;
  }
}

async function removeJob(jobName: string | null): Promise<void> {
  if (!jobName) return;
  try {
    await deleteVisitTranscriptionJob(jobName);
  } catch {
    // Amazon Transcribe expires job records on its own after 90 days.
  }
}

function summarize(recording: typeof visitRecordings.$inferSelect) {
  return {
    id: recording.id,
    status: recording.status,
    createdAt: recording.createdAt,
    transcribedAt: recording.transcribedAt,
    failureReason: recording.failureReason,
    transcript: recording.transcript,
    audioStored: Boolean(recording.audioObjectKey && !recording.audioDeletedAt),
  };
}

export const visitRecordingsRouter = createRouter({
  /** Consent state and recordings for one visit, plus what is configured. */
  forAppointment: protectedProcedure
    .use(requireRole(...RECORDING_ROLES))
    .input(
      z.object({
        patientId: z.string().uuid(),
        appointmentId: z.string().uuid(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const [appointment] = await ctx.db
        .select({ id: appointments.id })
        .from(appointments)
        .where(
          and(
            eq(appointments.id, input.appointmentId),
            eq(appointments.patientId, input.patientId),
            eq(appointments.practiceId, ctx.practiceId),
            isNull(appointments.deletedAt),
          ),
        )
        .limit(1);
      if (!appointment) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Visit not found" });
      }

      const consent = await latestConsent(ctx, input.appointmentId);
      const recordings = await ctx.db
        .select()
        .from(visitRecordings)
        .where(
          and(
            eq(visitRecordings.practiceId, ctx.practiceId),
            eq(visitRecordings.appointmentId, input.appointmentId),
            isNull(visitRecordings.deletedAt),
          ),
        )
        .orderBy(desc(visitRecordings.createdAt));

      return {
        transcriptionConfigured: visitRecordingTranscriptionConfigured(),
        aiConfigured: isAgentConfigured(),
        disclosure: VISIT_RECORDING_DISCLOSURE,
        disclosureVersion:
          VISIT_RECORDING_DISCLOSURE_VERSION as typeof VISIT_RECORDING_DISCLOSURE_VERSION,
        consent: consent
          ? { ...consent, active: consentIsActive(consent) }
          : null,
        recordings: recordings.map(summarize),
      };
    }),

  /**
   * Record the client's answer to the recording disclosure. A "no" is kept
   * as evidence too, and blocks recording until a later "yes".
   */
  recordConsent: protectedProcedure
    .use(requireRole(...RECORDING_ROLES))
    .input(
      z.object({
        patientId: z.string().uuid(),
        appointmentId: z.string().uuid(),
        signerName: z.string().trim().min(1).max(255),
        granted: z.boolean(),
        disclosureVersion: z.literal(VISIT_RECORDING_DISCLOSURE_VERSION),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const visit = await lockOpenVisitForClinicalAppend(ctx.db, {
        practiceId: ctx.practiceId,
        patientId: input.patientId,
        appointmentId: input.appointmentId,
      });
      if (!visit.ok) throw visitGuardError(visit.reason);

      const [consent] = await ctx.db
        .insert(visitRecordingConsents)
        .values({
          practiceId: ctx.practiceId,
          patientId: input.patientId,
          appointmentId: input.appointmentId,
          action: input.granted ? "granted" : "declined",
          signerName: input.signerName,
          disclosureVersion: VISIT_RECORDING_DISCLOSURE_VERSION,
          disclosure: VISIT_RECORDING_DISCLOSURE,
          actorUserId: ctx.user.id,
          actorName: ctx.user.name?.trim() || ctx.user.email,
        })
        .returning({
          id: visitRecordingConsents.id,
          action: visitRecordingConsents.action,
          occurredAt: visitRecordingConsents.occurredAt,
        });
      return consent;
    }),

  /** Open a recording slot for the visit. Requires a current "yes". */
  start: protectedProcedure
    .use(requireRole(...RECORDING_ROLES))
    .input(
      z.object({
        patientId: z.string().uuid(),
        appointmentId: z.string().uuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!visitRecordingTranscriptionConfigured()) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Visit recording is not set up on this server.",
        });
      }
      const visit = await lockOpenVisitForClinicalAppend(ctx.db, {
        practiceId: ctx.practiceId,
        patientId: input.patientId,
        appointmentId: input.appointmentId,
      });
      if (!visit.ok) throw visitGuardError(visit.reason);

      const consent = await latestConsent(ctx, input.appointmentId);
      if (!consent || !consentIsActive(consent)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "The client has not agreed to recording for this visit.",
        });
      }

      const [{ total }] = await ctx.db
        .select({ total: count() })
        .from(visitRecordings)
        .where(
          and(
            eq(visitRecordings.practiceId, ctx.practiceId),
            eq(visitRecordings.appointmentId, input.appointmentId),
          ),
        );
      if (total >= VISIT_RECORDINGS_PER_APPOINTMENT_LIMIT) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "This visit already has the maximum number of recordings.",
        });
      }

      const [recording] = await ctx.db
        .insert(visitRecordings)
        .values({
          practiceId: ctx.practiceId,
          patientId: input.patientId,
          appointmentId: input.appointmentId,
          consentId: consent.id,
          createdBy: ctx.user.id,
        })
        .returning({ id: visitRecordings.id });
      return recording;
    }),

  /**
   * Check on a transcription. When it is done, store the transcript and
   * delete the audio; when it failed, delete the audio and say why.
   */
  sync: protectedProcedure
    .use(requireRole(...RECORDING_ROLES))
    .input(z.object({ recordingId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const recording = await lockRecording(ctx, input.recordingId);
      if (
        recording.status !== "transcribing" ||
        !recording.transcriptionJobName
      ) {
        return summarize(recording);
      }
      if (!(await lockPracticeForExternalSideEffects(ctx.db, ctx.practiceId))) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: RECOVERY_HOLD_BLOCK_MESSAGE,
        });
      }

      let poll;
      try {
        poll = await pollVisitTranscription(recording.transcriptionJobName);
      } catch {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Could not reach the transcription service. Try again.",
        });
      }
      if (poll.state === "in_progress") return summarize(recording);

      const audioGone = await removeAudio(recording);
      await removeJob(recording.transcriptionJobName);
      const now = new Date();
      const [updated] = await ctx.db
        .update(visitRecordings)
        .set(
          poll.state === "completed"
            ? {
                status: "transcribed",
                transcript: poll.transcript,
                transcribedAt: now,
                failureReason: null,
                audioDeletedAt: audioGone ? now : null,
              }
            : {
                status: "failed",
                failureReason: poll.reason,
                audioDeletedAt: audioGone ? now : null,
              },
        )
        .where(
          and(
            eq(visitRecordings.id, recording.id),
            eq(visitRecordings.practiceId, ctx.practiceId),
          ),
        )
        .returning();
      return summarize(updated);
    }),

  /** Delete the audio (if any) and the transcript. The row stays as history. */
  discard: protectedProcedure
    .use(requireRole(...RECORDING_ROLES))
    .input(z.object({ recordingId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const recording = await lockRecording(ctx, input.recordingId);
      if (recording.status === "discarded") return summarize(recording);

      const audioGone = await removeAudio(recording);
      if (recording.status === "transcribing") {
        await removeJob(recording.transcriptionJobName);
      }
      const [updated] = await ctx.db
        .update(visitRecordings)
        .set({
          status: "discarded",
          transcript: null,
          transcribedAt: null,
          audioDeletedAt:
            recording.audioObjectKey && audioGone
              ? (recording.audioDeletedAt ?? new Date())
              : recording.audioDeletedAt,
        })
        .where(
          and(
            eq(visitRecordings.id, recording.id),
            eq(visitRecordings.practiceId, ctx.practiceId),
          ),
        )
        .returning();
      return summarize(updated);
    }),
});
