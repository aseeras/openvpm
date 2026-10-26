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
  deleteTranscript,
  deleteVisitRoom,
  downloadTranscript,
  latestTranscript,
  stopTranscription,
  telehealthVideoConfigured,
  TelehealthVideoUnavailableError,
} from "@/lib/telehealth/daily";
import {
  formatTranscript,
  parseTranscriptVtt,
  TRANSCRIPT_PROCESSING_TIMEOUT_MS,
} from "@/lib/telehealth/transcript";
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
      let transcriptStatus = visit.transcriptStatus;
      if (visit.videoRoomName && transcriptStatus === "active") {
        await stopTranscription(visit.videoRoomName).catch(() => {});
      }
      if (transcriptStatus === "active" || transcriptStatus === "stopped") {
        transcriptStatus = "processing";
      } else if (transcriptStatus === "requested") {
        transcriptStatus = "off";
      }
      // Rooms also expire on their own, so a failed delete is not fatal. A
      // room with a transcript is left to expire so Daily can finish saving
      // the file.
      if (visit.videoRoomName && transcriptStatus !== "processing") {
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
      if (visit.transcriptStatus === "active" || visit.transcriptStatus === "requested") {
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
      if (visit.transcriptStatus !== "active" || !visit.videoRoomName) {
        return { transcriptStatus: visit.transcriptStatus };
      }
      try {
        await stopTranscription(visit.videoRoomName);
      } catch (error) {
        throw videoError(error);
      }
      await ctx.db
        .update(telehealthVisits)
        .set({ transcriptStatus: "stopped" })
        .where(eq(telehealthVisits.id, visit.id));
      return { transcriptStatus: "stopped" as const };
    }),

  /**
   * After the call, copy the finished transcript from Daily into the visit,
   * then delete Daily's copy. Safe to call repeatedly while it is processing.
   */
  syncTranscript: protectedProcedure
    .use(requireRole(...CLINICIAN_ROLES))
    .input(z.object({ visitId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const visit = await lockVisit(ctx, input.visitId);
      if (visit.transcriptStatus !== "processing" || !visit.videoRoomName) {
        return { transcriptStatus: visit.transcriptStatus };
      }
      const fail = async (message: string) => {
        await ctx.db
          .update(telehealthVisits)
          .set({ transcriptStatus: "failed", transcriptError: message })
          .where(eq(telehealthVisits.id, visit.id));
        return { transcriptStatus: "failed" as const };
      };
      let info;
      try {
        info = await latestTranscript(visit.videoRoomName);
      } catch (error) {
        throw videoError(error);
      }
      const waitedTooLong =
        Date.now() - (visit.endedAt ?? new Date()).getTime() >
        TRANSCRIPT_PROCESSING_TIMEOUT_MS;
      if (!info || info.status === "t_in_progress" || !info.isVttAvailable) {
        if (info?.status === "t_error") {
          return fail("The video service could not finish the transcript.");
        }
        return waitedTooLong
          ? fail("No transcript was saved for this call.")
          : { transcriptStatus: "processing" as const };
      }
      if (info.status !== "t_finished") {
        return fail("The video service could not finish the transcript.");
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
      let text: string;
      try {
        const vtt = await downloadTranscript(info.transcriptId);
        text = formatTranscript(
          parseTranscriptVtt(vtt, [names?.clinicianName ?? "", names?.clientName ?? ""]),
        ).slice(0, 200000);
      } catch (error) {
        throw videoError(error);
      }
      if (!text.trim()) return fail("The transcript was empty.");
      await ctx.db
        .update(telehealthVisits)
        .set({ transcriptStatus: "ready", transcript: text, transcriptError: null })
        .where(eq(telehealthVisits.id, visit.id));
      // Keep only our copy; Daily's is no longer needed.
      await deleteTranscript(info.transcriptId).catch(() => {});
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
