import { z } from "zod";
import { and, asc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import {
  clients,
  patients,
  practices,
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
      await ctx.db
        .update(telehealthVisits)
        .set({
          status: "in_call",
          clinicianId: ctx.user.id,
          videoRoomName: roomName,
          startedAt: new Date(),
        })
        .where(eq(telehealthVisits.id, visit.id));
      return { url };
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
      if (visit.videoRoomName) {
        // Rooms also expire on their own, so a failed delete is not fatal.
        await deleteVisitRoom(visit.videoRoomName).catch(() => {});
      }
      await ctx.db
        .update(telehealthVisits)
        .set({ status: "completed", endedAt: new Date() })
        .where(eq(telehealthVisits.id, visit.id));
      return { status: "completed" as const };
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
