import { z } from "zod";
import { and, asc, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import {
  appointments,
  clients,
  patients,
  practices,
  telehealthTranscriptConsents,
  telehealthVisits,
  users,
} from "@openpims/db";
import type { Database } from "@openpims/db/client";
import { createRouter, protectedProcedure, requireRole } from "../trpc";
import {
  lockPracticeForExternalSideEffects,
  RECOVERY_HOLD_BLOCK_MESSAGE,
} from "@/lib/recovery-hold";
import {
  createJoinUrl,
  createVisitRoom,
  deleteVisitRoom,
  telehealthVideoConfigured,
  TelehealthVideoUnavailableError,
} from "@/lib/telehealth/daily";
import { TRANSCRIPT_UPLOAD_TIMEOUT_MS } from "@/lib/telehealth/transcript";
import {
  deleteVisitAudio,
  deleteVisitTranscriptionJob,
  formatChannelTranscript,
  pollVisitTranscription,
  visitRecordingTranscriptionConfigured,
} from "@/lib/visit-recordings/aws";
import { telehealthSettings } from "@/lib/telehealth/visits";

/** Staff who see the video-visit queue. */
const QUEUE_ROLES = [
  "admin",
  "veterinarian",
  "technician",
  "front_desk",
] as const;
/** Staff who run the video call itself. */
const CLINICIAN_ROLES = ["admin", "veterinarian"] as const;
const RECENT_WINDOW_MS = 12 * 60 * 60 * 1000;
/** Video visits go on the schedule as a short visit, like a recheck. */
const VISIT_LENGTH_MS = 15 * 60 * 1000;

type StaffCtx = { db: Database; practiceId: string };

function videoError(error: unknown): TRPCError {
  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message:
      error instanceof TelehealthVideoUnavailableError
        ? error.message
        : "Could not reach the video service. Try again.",
  });
}

async function lockVisit(ctx: StaffCtx, visitId: string) {
  const [visit] = await ctx.db
    .select()
    .from(telehealthVisits)
    .where(
      and(
        eq(telehealthVisits.id, visitId),
        eq(telehealthVisits.practiceId, ctx.practiceId),
        isNull(telehealthVisits.deletedAt),
      ),
    )
    .for("update");
  if (!visit) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Video visit not found",
    });
  }
  return visit;
}

async function assertExternalSideEffectsAllowed(ctx: StaffCtx) {
  if (!(await lockPracticeForExternalSideEffects(ctx.db, ctx.practiceId))) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: RECOVERY_HOLD_BLOCK_MESSAGE,
    });
  }
}

export const telehealthRouter = createRouter({
  /** Open visits plus today's finished ones, oldest waiting first. */
  queue: protectedProcedure
    .use(requireRole(...QUEUE_ROLES))
    .query(async ({ ctx }) => {
      const [practice] = await ctx.db
        .select({ settings: practices.settings })
        .from(practices)
        .where(
          and(eq(practices.id, ctx.practiceId), isNull(practices.deletedAt)),
        )
        .limit(1);
      const since = new Date(Date.now() - RECENT_WINDOW_MS);
      const rows = await ctx.db
        .select({
          id: telehealthVisits.id,
          status: telehealthVisits.status,
          reason: telehealthVisits.reason,
          notes: telehealthVisits.notes,
          createdAt: telehealthVisits.createdAt,
          startedAt: telehealthVisits.startedAt,
          endedAt: telehealthVisits.endedAt,
          clinicianId: telehealthVisits.clinicianId,
          clinicianName: users.name,
          patientId: patients.id,
          patientName: patients.name,
          species: patients.species,
          clientId: clients.id,
          clientName: sql<string>`btrim(${clients.firstName} || ' ' || ${clients.lastName})`,
          clientPhone: clients.phone,
          appointmentId: telehealthVisits.appointmentId,
          transcriptStatus: telehealthVisits.transcriptStatus,
          transcriptError: telehealthVisits.transcriptError,
        })
        .from(telehealthVisits)
        .innerJoin(patients, eq(patients.id, telehealthVisits.patientId))
        .innerJoin(clients, eq(clients.id, telehealthVisits.clientId))
        .leftJoin(users, eq(users.id, telehealthVisits.clinicianId))
        .where(
          and(
            eq(telehealthVisits.practiceId, ctx.practiceId),
            isNull(telehealthVisits.deletedAt),
            sql`(${inArray(telehealthVisits.status, ["waiting", "in_call"])} or ${gte(telehealthVisits.createdAt, since)})`,
          ),
        )
        .orderBy(asc(telehealthVisits.createdAt))
        .limit(100);

      return {
        configured: telehealthVideoConfigured(),
        accepting: telehealthSettings(practice?.settings).accepting,
        open: rows.filter(
          (row) => row.status === "waiting" || row.status === "in_call",
        ),
        recent: rows
          .filter((row) => row.status !== "waiting" && row.status !== "in_call")
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, 20),
      };
    }),

  /** Turn the clinic's "taking video visits now" switch on or off. */
  setAccepting: protectedProcedure
    .use(requireRole(...CLINICIAN_ROLES))
    .input(z.object({ accepting: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .update(practices)
        .set({
          settings: sql`jsonb_set(coalesce(${practices.settings}, '{}'::jsonb), '{telehealth}', coalesce(${practices.settings}->'telehealth', '{}'::jsonb) || ${JSON.stringify({ accepting: input.accepting })}::jsonb)`,
        })
        .where(
          and(eq(practices.id, ctx.practiceId), isNull(practices.deletedAt)),
        );
      return { accepting: input.accepting };
    }),

  /** Admit the client: open a private room and return the clinician's link. */
  start: protectedProcedure
    .use(requireRole(...CLINICIAN_ROLES))
    .input(z.object({ visitId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const visit = await lockVisit(ctx, input.visitId);
      if (visit.status !== "waiting") {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            visit.status === "in_call"
              ? "This visit has already started."
              : "This client is no longer waiting.",
        });
      }
      await assertExternalSideEffectsAllowed(ctx);
      let roomName: string;
      let url: string;
      try {
        ({ name: roomName } = await createVisitRoom());
        url = await createJoinUrl({
          roomName,
          userName: ctx.user.name || "Veterinarian",
          isClinician: true,
        });
      } catch (error) {
        throw videoError(error);
      }
      // Open the visit on the schedule so the note, any charges and the
      // checkout follow the usual visit flow.
      const now = new Date();
      const [appointment] = await ctx.db
        .insert(appointments)
        .values({
          practiceId: ctx.practiceId,
          patientId: visit.patientId,
          clientId: visit.clientId,
          doctorId: ctx.user.id,
          startTime: now,
          endTime: new Date(now.getTime() + VISIT_LENGTH_MS),
          status: "in_exam",
          notes: `Video visit: ${visit.reason}`,
        })
        .returning({ id: appointments.id });
      await ctx.db
        .update(telehealthVisits)
        .set({
          status: "in_call",
          clinicianId: ctx.user.id,
          videoRoomName: roomName,
          startedAt: now,
          appointmentId: appointment?.id ?? null,
        })
        .where(eq(telehealthVisits.id, visit.id));
      return { url, appointmentId: appointment?.id ?? null };
    }),

  /** A fresh link back into a visit that is still in progress. */
  rejoin: protectedProcedure
    .use(requireRole(...CLINICIAN_ROLES))
    .input(z.object({ visitId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const visit = await lockVisit(ctx, input.visitId);
      if (visit.status !== "in_call" || !visit.videoRoomName) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "This visit is not in progress.",
        });
      }
      await assertExternalSideEffectsAllowed(ctx);
      try {
        const url = await createJoinUrl({
          roomName: visit.videoRoomName,
          userName: ctx.user.name || "Veterinarian",
          isClinician: true,
        });
        return { url };
      } catch (error) {
        throw videoError(error);
      }
    }),

  /** Finish the visit and close the room so nobody can rejoin it. */
  end: protectedProcedure
    .use(requireRole(...CLINICIAN_ROLES))
    .input(z.object({ visitId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const visit = await lockVisit(ctx, input.visitId);
      if (visit.status !== "in_call") return { status: visit.status };
      // A transcript being recorded stops with the call; the clinician's
      // browser then uploads the audio.
      let transcriptStatus = visit.transcriptStatus;
      if (transcriptStatus === "active") transcriptStatus = "stopped";
      else if (transcriptStatus === "requested") transcriptStatus = "off";
      if (visit.videoRoomName) {
        // Rooms also expire on their own, so a failed delete is not fatal.
        await deleteVisitRoom(visit.videoRoomName).catch(() => {});
      }
      await ctx.db
        .update(telehealthVisits)
        .set({ status: "completed", endedAt: new Date(), transcriptStatus })
        .where(eq(telehealthVisits.id, visit.id));
      return { status: "completed" as const, transcriptStatus };
    }),

  /** Ask the client, in their app, to agree to a transcript of this call. */
  requestTranscript: protectedProcedure
    .use(requireRole(...CLINICIAN_ROLES))
    .input(z.object({ visitId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const visit = await lockVisit(ctx, input.visitId);
      if (visit.status !== "in_call") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "This visit is not in progress.",
        });
      }
      if (!visitRecordingTranscriptionConfigured()) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Transcripts need visit recording (Amazon Transcribe) set up on this server.",
        });
      }
      // One transcript per visit: once recorded it can't be restarted.
      if (!["off", "declined", "failed"].includes(visit.transcriptStatus)) {
        return { transcriptStatus: visit.transcriptStatus };
      }
      await ctx.db
        .update(telehealthVisits)
        .set({ transcriptStatus: "requested", transcriptError: null })
        .where(eq(telehealthVisits.id, visit.id));
      return { transcriptStatus: "requested" as const };
    }),

  /** Stop transcribing (or withdraw the request) during the call. */
  stopTranscript: protectedProcedure
    .use(requireRole(...CLINICIAN_ROLES))
    .input(z.object({ visitId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const visit = await lockVisit(ctx, input.visitId);
      if (visit.transcriptStatus === "requested") {
        await ctx.db
          .update(telehealthVisits)
          .set({ transcriptStatus: "off" })
          .where(eq(telehealthVisits.id, visit.id));
        return { transcriptStatus: "off" as const };
      }
      if (visit.transcriptStatus !== "active") {
        return { transcriptStatus: visit.transcriptStatus };
      }
      // The clinician's browser sees this, stops recording and uploads.
      await ctx.db
        .update(telehealthVisits)
        .set({ transcriptStatus: "stopped" })
        .where(eq(telehealthVisits.id, visit.id));
      return { transcriptStatus: "stopped" as const };
    }),

  /**
   * After the call, check on Amazon Transcribe and store the transcript, then
   * delete the audio and the job. Safe to call repeatedly while processing.
   */
  syncTranscript: protectedProcedure
    .use(requireRole(...CLINICIAN_ROLES))
    .input(z.object({ visitId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const visit = await lockVisit(ctx, input.visitId);
      const fail = async (message: string) => {
        await ctx.db
          .update(telehealthVisits)
          .set({ transcriptStatus: "failed", transcriptError: message })
          .where(eq(telehealthVisits.id, visit.id));
        return { transcriptStatus: "failed" as const };
      };
      // The browser that recorded the call never uploaded it (closed tab).
      if (visit.transcriptStatus === "stopped" && visit.status !== "in_call") {
        const waited = Date.now() - (visit.endedAt ?? new Date()).getTime();
        return waited > TRANSCRIPT_UPLOAD_TIMEOUT_MS
          ? fail("The call audio was not uploaded, so no transcript was made.")
          : { transcriptStatus: "stopped" as const };
      }
      if (visit.transcriptStatus !== "processing" || !visit.transcriptionJobName) {
        return { transcriptStatus: visit.transcriptStatus };
      }
      const [names] = await ctx.db
        .select({
          clinicianName: users.name,
          clientName: sql<string>`btrim(${clients.firstName} || ' ' || ${clients.lastName})`,
        })
        .from(telehealthVisits)
        .innerJoin(clients, eq(clients.id, telehealthVisits.clientId))
        .leftJoin(users, eq(users.id, telehealthVisits.clinicianId))
        .where(eq(telehealthVisits.id, visit.id))
        .limit(1);
      // Channel 0 is the clinician's microphone, channel 1 the client.
      const speakers = [names?.clinicianName || "Veterinarian", names?.clientName || "Client"];
      let poll;
      try {
        poll = await pollVisitTranscription(visit.transcriptionJobName, (output) =>
          formatChannelTranscript(output, speakers),
        );
      } catch {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Could not reach the transcription service. Try again.",
        });
      }
      if (poll.state === "in_progress") return { transcriptStatus: "processing" as const };

      // Done either way: the audio and the service's copy are no longer needed.
      if (visit.audioObjectKey) {
        await deleteVisitAudio({ key: visit.audioObjectKey, versionId: visit.audioObjectVersionId }).catch(() => {});
      }
      await deleteVisitTranscriptionJob(visit.transcriptionJobName).catch(() => {});
      await ctx.db
        .update(telehealthVisits)
        .set({ audioObjectKey: null, audioObjectVersionId: null })
        .where(eq(telehealthVisits.id, visit.id));

      if (poll.state === "failed") return fail(poll.reason.slice(0, 300));
      await ctx.db
        .update(telehealthVisits)
        .set({ transcriptStatus: "ready", transcript: poll.transcript, transcriptError: null })
        .where(eq(telehealthVisits.id, visit.id));
      return { transcriptStatus: "ready" as const };
    }),

  /** One visit's transcript and the client's consent, for the clinician. */
  transcript: protectedProcedure
    .use(requireRole(...CLINICIAN_ROLES))
    .input(z.object({ visitId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const [visit] = await ctx.db
        .select({
          id: telehealthVisits.id,
          patientId: telehealthVisits.patientId,
          patientName: patients.name,
          appointmentId: telehealthVisits.appointmentId,
          transcriptStatus: telehealthVisits.transcriptStatus,
          transcript: telehealthVisits.transcript,
          transcriptError: telehealthVisits.transcriptError,
          endedAt: telehealthVisits.endedAt,
        })
        .from(telehealthVisits)
        .innerJoin(patients, eq(patients.id, telehealthVisits.patientId))
        .where(
          and(
            eq(telehealthVisits.id, input.visitId),
            eq(telehealthVisits.practiceId, ctx.practiceId),
            isNull(telehealthVisits.deletedAt),
          ),
        )
        .limit(1);
      if (!visit) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Video visit not found" });
      }
      const [consent] = await ctx.db
        .select({
          signerName: telehealthTranscriptConsents.signerName,
          createdAt: telehealthTranscriptConsents.createdAt,
        })
        .from(telehealthTranscriptConsents)
        .where(
          and(
            eq(telehealthTranscriptConsents.practiceId, ctx.practiceId),
            eq(telehealthTranscriptConsents.visitId, visit.id),
            eq(telehealthTranscriptConsents.action, "granted"),
          ),
        )
        .orderBy(desc(telehealthTranscriptConsents.createdAt))
        .limit(1);
      return { ...visit, consent: consent ?? null };
    }),

  /** Turn a waiting client away, with an optional note they'll see. */
  decline: protectedProcedure
    .use(requireRole(...CLINICIAN_ROLES))
    .input(
      z.object({
        visitId: z.string().uuid(),
        reason: z.string().trim().max(300).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const visit = await lockVisit(ctx, input.visitId);
      if (visit.status !== "waiting") return { status: visit.status };
      await ctx.db
        .update(telehealthVisits)
        .set({
          status: "declined",
          declineReason: input.reason ? input.reason : null,
          endedAt: new Date(),
        })
        .where(eq(telehealthVisits.id, visit.id));
      return { status: "declined" as const };
    }),
});
