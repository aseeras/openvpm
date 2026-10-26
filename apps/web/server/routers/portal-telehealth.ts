import { z } from "zod";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  sql,
} from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import {
  clients,
  patients,
  practices,
  telehealthTranscriptConsents,
  telehealthVisits,
  users,
} from "@openpims/db";
import type { Database } from "@openpims/db/client";
import { createRouter, portalProcedure } from "../trpc";
import { rateLimit } from "@/lib/rate-limit";
import { billingEnforced, hasHostedFullAccess } from "@/lib/billing/plans";
import {
  createJoinUrl,
  startTranscription,
  stopTranscription,
  telehealthVideoConfigured,
  TelehealthVideoUnavailableError,
} from "@/lib/telehealth/daily";
import {
  TRANSCRIPT_DISCLOSURE_VERSION,
  transcriptDisclosure,
} from "@/lib/telehealth/transcript";
import {
  establishedPatientPredicate,
  isEstablishedPatient,
  TELEHEALTH_NOTES_MAX_LENGTH,
  TELEHEALTH_REASONS,
  telehealthSettings,
} from "@/lib/telehealth/visits";

/**
 * Client side of video visits. Portal procedures run in a system-scoped
 * transaction, so every query here is pinned to the session's practice and
 * client explicitly.
 */

const OPEN_STATUSES = ["waiting", "in_call"] as const;

type PortalCtx = {
  db: Database;
  portalClient: { id: string; practiceId: string };
  portalSessionId: string;
};

async function limit(key: string, max: number, windowMs: number) {
  const result = await rateLimit({ key, limit: max, windowMs }).catch(() => ({
    success: false,
  }));
  if (!result.success) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "Too many requests. Please wait a moment or call the clinic.",
    });
  }
}

async function sessionClient(ctx: PortalCtx) {
  const [client] = await ctx.db
    .select({
      id: clients.id,
      practiceId: clients.practiceId,
      firstName: clients.firstName,
      lastName: clients.lastName,
    })
    .from(clients)
    .innerJoin(
      practices,
      and(eq(practices.id, clients.practiceId), isNull(practices.deletedAt)),
    )
    .where(
      and(
        eq(clients.id, ctx.portalClient.id),
        eq(clients.practiceId, ctx.portalClient.practiceId),
        isNull(clients.deletedAt),
      ),
    )
    .limit(1);
  if (!client) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Invalid portal link" });
  }
  return client;
}

async function practiceVideoState(db: Database, practiceId: string) {
  const [practice] = await db
    .select({
      name: practices.name,
      logoUrl: practices.logoUrl,
      settings: practices.settings,
      tier: practices.subscriptionTier,
      billingStatus: practices.billingStatus,
      trialEndsAt: practices.trialEndsAt,
    })
    .from(practices)
    .where(and(eq(practices.id, practiceId), isNull(practices.deletedAt)))
    .limit(1);
  if (!practice) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Invalid portal link" });
  }
  const subscribed =
    !billingEnforced() ||
    hasHostedFullAccess(
      practice.tier,
      practice.billingStatus,
      practice.trialEndsAt,
    );
  return {
    name: practice.name,
    logoUrl: practice.logoUrl,
    configured: telehealthVideoConfigured() && subscribed,
    accepting: telehealthSettings(practice.settings).accepting,
  };
}

async function openVisitForClient(
  db: Database,
  client: { id: string; practiceId: string },
) {
  const [visit] = await db
    .select({
      id: telehealthVisits.id,
      status: telehealthVisits.status,
      reason: telehealthVisits.reason,
      createdAt: telehealthVisits.createdAt,
      patientId: telehealthVisits.patientId,
      patientName: patients.name,
      patientPhotoUrl: patients.photoUrl,
      startedAt: telehealthVisits.startedAt,
      clinicianName: users.name,
      transcriptStatus: telehealthVisits.transcriptStatus,
    })
    .from(telehealthVisits)
    .innerJoin(patients, eq(patients.id, telehealthVisits.patientId))
    .leftJoin(users, eq(users.id, telehealthVisits.clinicianId))
    .where(
      and(
        eq(telehealthVisits.practiceId, client.practiceId),
        eq(telehealthVisits.clientId, client.id),
        inArray(telehealthVisits.status, [...OPEN_STATUSES]),
        isNull(telehealthVisits.deletedAt),
      ),
    )
    .orderBy(desc(telehealthVisits.createdAt))
    .limit(1);
  return visit ?? null;
}

export const portalTelehealthRouter = createRouter({
  /** Waiting-room state; the page polls this every few seconds. */
  status: portalProcedure.query(async ({ ctx }) => {
    await limit(
      `portal-telehealth-read:${ctx.portalSessionId}`,
      600,
      15 * 60 * 1000,
    );
    const client = await sessionClient(ctx);
    const practice = await practiceVideoState(ctx.db, client.practiceId);
    const pets = await ctx.db
      .select({
        id: patients.id,
        name: patients.name,
        species: patients.species,
        breed: patients.breed,
        photoUrl: patients.photoUrl,
        established: sql<boolean>`${establishedPatientPredicate(client.practiceId, patients.id)}`,
      })
      .from(patients)
      .where(
        and(
          eq(patients.practiceId, client.practiceId),
          eq(patients.clientId, client.id),
          eq(patients.status, "active"),
          isNull(patients.deletedAt),
        ),
      )
      .orderBy(asc(patients.name));

    const visit = await openVisitForClient(ctx.db, client);
    let ahead = 0;
    if (visit?.status === "waiting") {
      const [row] = await ctx.db
        .select({ total: count() })
        .from(telehealthVisits)
        .where(
          and(
            eq(telehealthVisits.practiceId, client.practiceId),
            eq(telehealthVisits.status, "waiting"),
            lt(telehealthVisits.createdAt, visit.createdAt),
            isNull(telehealthVisits.deletedAt),
          ),
        );
      ahead = row?.total ?? 0;
    }

    // So a client who was turned away, or whose visit just ended, is told so.
    const [lastClosed] = visit
      ? []
      : await ctx.db
          .select({
            id: telehealthVisits.id,
            status: telehealthVisits.status,
            declineReason: telehealthVisits.declineReason,
            reason: telehealthVisits.reason,
            startedAt: telehealthVisits.startedAt,
            endedAt: telehealthVisits.endedAt,
            patientName: patients.name,
            patientPhotoUrl: patients.photoUrl,
            clinicianName: users.name,
          })
          .from(telehealthVisits)
          .innerJoin(patients, eq(patients.id, telehealthVisits.patientId))
          .leftJoin(users, eq(users.id, telehealthVisits.clinicianId))
          .where(
            and(
              eq(telehealthVisits.practiceId, client.practiceId),
              eq(telehealthVisits.clientId, client.id),
              inArray(telehealthVisits.status, ["completed", "declined"]),
              gte(
                telehealthVisits.endedAt,
                new Date(Date.now() - 30 * 60 * 1000),
              ),
              isNull(telehealthVisits.deletedAt),
            ),
          )
          .orderBy(desc(telehealthVisits.endedAt))
          .limit(1);

    return {
      practiceName: practice.name,
      practiceLogoUrl: practice.logoUrl,
      lastClosed: lastClosed ?? null,
      configured: practice.configured,
      accepting: practice.accepting,
      reasons: TELEHEALTH_REASONS,
      pets: pets.map((pet) => ({
        ...pet,
        established: Boolean(pet.established),
      })),
      visit: visit
        ? {
            ...visit,
            ahead,
            // What the client is asked to agree to, when the vet asks.
            transcriptDisclosure:
              visit.transcriptStatus === "requested"
                ? transcriptDisclosure({
                    clinicianName: visit.clinicianName,
                    patientName: visit.patientName,
                    practiceName: practice.name,
                  })
                : null,
          }
        : null,
    };
  }),

  /** The client's answer to the veterinarian's transcript request. */
  answerTranscript: portalProcedure
    .input(z.object({ visitId: z.string().uuid(), allow: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await limit(`portal-telehealth-transcript:${ctx.portalSessionId}`, 20, 60 * 60 * 1000);
      const client = await sessionClient(ctx);
      const practice = await practiceVideoState(ctx.db, client.practiceId);
      const [visit] = await ctx.db
        .select({
          id: telehealthVisits.id,
          status: telehealthVisits.status,
          transcriptStatus: telehealthVisits.transcriptStatus,
          roomName: telehealthVisits.videoRoomName,
          patientName: patients.name,
          clinicianName: users.name,
        })
        .from(telehealthVisits)
        .innerJoin(patients, eq(patients.id, telehealthVisits.patientId))
        .leftJoin(users, eq(users.id, telehealthVisits.clinicianId))
        .where(
          and(
            eq(telehealthVisits.id, input.visitId),
            eq(telehealthVisits.practiceId, client.practiceId),
            eq(telehealthVisits.clientId, client.id),
            isNull(telehealthVisits.deletedAt),
          ),
        )
        .for("update", { of: telehealthVisits })
        .limit(1);
      if (!visit || visit.status !== "in_call" || visit.transcriptStatus !== "requested") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "There is no transcript request to answer.",
        });
      }
      await ctx.db.insert(telehealthTranscriptConsents).values({
        practiceId: client.practiceId,
        visitId: visit.id,
        clientId: client.id,
        action: input.allow ? "granted" : "declined",
        signerName: `${client.firstName} ${client.lastName}`.trim() || "Client",
        disclosureVersion: TRANSCRIPT_DISCLOSURE_VERSION,
        disclosure: transcriptDisclosure({
          clinicianName: visit.clinicianName,
          patientName: visit.patientName,
          practiceName: practice.name,
        }),
      });
      if (!input.allow) {
        await ctx.db
          .update(telehealthVisits)
          .set({ transcriptStatus: "declined" })
          .where(eq(telehealthVisits.id, visit.id));
        return { transcriptStatus: "declined" as const };
      }
      try {
        if (!visit.roomName) throw new TelehealthVideoUnavailableError();
        await startTranscription(visit.roomName);
      } catch {
        await ctx.db
          .update(telehealthVisits)
          .set({
            transcriptStatus: "failed",
            transcriptError:
              "The video service could not start a transcript. Transcription may not be enabled for this video account.",
          })
          .where(eq(telehealthVisits.id, visit.id));
        return { transcriptStatus: "failed" as const };
      }
      await ctx.db
        .update(telehealthVisits)
        .set({ transcriptStatus: "active", transcriptError: null })
        .where(eq(telehealthVisits.id, visit.id));
      return { transcriptStatus: "active" as const };
    }),

  /** The client can stop the transcript at any time during the call. */
  stopTranscript: portalProcedure
    .input(z.object({ visitId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const client = await sessionClient(ctx);
      const [visit] = await ctx.db
        .select({
          id: telehealthVisits.id,
          transcriptStatus: telehealthVisits.transcriptStatus,
          roomName: telehealthVisits.videoRoomName,
        })
        .from(telehealthVisits)
        .where(
          and(
            eq(telehealthVisits.id, input.visitId),
            eq(telehealthVisits.practiceId, client.practiceId),
            eq(telehealthVisits.clientId, client.id),
            isNull(telehealthVisits.deletedAt),
          ),
        )
        .for("update")
        .limit(1);
      if (!visit || visit.transcriptStatus !== "active") {
        return { transcriptStatus: visit?.transcriptStatus ?? "off" };
      }
      // Only report "stopped" once the video service has actually stopped.
      try {
        if (visit.roomName) await stopTranscription(visit.roomName);
      } catch {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Couldn't stop the transcript. Please try again.",
        });
      }
      await ctx.db
        .update(telehealthVisits)
        .set({ transcriptStatus: "stopped" })
        .where(eq(telehealthVisits.id, visit.id));
      return { transcriptStatus: "stopped" as const };
    }),

  /** Ask for a video visit and enter the waiting room. */
  request: portalProcedure
    .input(
      z.object({
        patientId: z.string().uuid(),
        reason: z.enum(TELEHEALTH_REASONS),
        notes: z.string().trim().max(TELEHEALTH_NOTES_MAX_LENGTH).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await limit(
        `portal-telehealth-request:${ctx.portalSessionId}`,
        10,
        60 * 60 * 1000,
      );
      const client = await sessionClient(ctx);
      const practice = await practiceVideoState(ctx.db, client.practiceId);
      if (!practice.configured || !practice.accepting) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Video visits aren't available right now. Please call the clinic.",
        });
      }

      const [pet] = await ctx.db
        .select({ id: patients.id })
        .from(patients)
        .where(
          and(
            eq(patients.id, input.patientId),
            eq(patients.practiceId, client.practiceId),
            eq(patients.clientId, client.id),
            eq(patients.status, "active"),
            isNull(patients.deletedAt),
          ),
        )
        .limit(1);
      if (!pet) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Pet not found" });
      }
      if (!(await isEstablishedPatient(ctx.db, client.practiceId, pet.id))) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "Video visits are for pets we've already seen in person. Please book an in-home first visit.",
        });
      }
      if (await openVisitForClient(ctx.db, client)) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "You're already in the waiting room.",
        });
      }

      const [visit] = await ctx.db
        .insert(telehealthVisits)
        .values({
          practiceId: client.practiceId,
          clientId: client.id,
          patientId: pet.id,
          reason: input.reason,
          notes: input.notes ? input.notes : null,
        })
        .onConflictDoNothing()
        .returning({ id: telehealthVisits.id });
      if (!visit) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "This pet is already in the waiting room.",
        });
      }
      return visit;
    }),

  /** Once the clinician has started the call, get this client's pass in. */
  join: portalProcedure
    .input(z.object({ visitId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await limit(
        `portal-telehealth-join:${ctx.portalSessionId}`,
        30,
        60 * 60 * 1000,
      );
      const client = await sessionClient(ctx);
      const [visit] = await ctx.db
        .select({
          status: telehealthVisits.status,
          roomName: telehealthVisits.videoRoomName,
        })
        .from(telehealthVisits)
        .where(
          and(
            eq(telehealthVisits.id, input.visitId),
            eq(telehealthVisits.practiceId, client.practiceId),
            eq(telehealthVisits.clientId, client.id),
            isNull(telehealthVisits.deletedAt),
          ),
        )
        .limit(1);
      if (!visit || visit.status !== "in_call" || !visit.roomName) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "The veterinarian hasn't started this visit yet.",
        });
      }
      try {
        const url = await createJoinUrl({
          roomName: visit.roomName,
          userName: `${client.firstName} ${client.lastName}`.trim(),
          isClinician: false,
        });
        return { url };
      } catch (error) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            error instanceof TelehealthVideoUnavailableError
              ? error.message
              : "Could not connect the video call. Try again.",
        });
      }
    }),

  /** Leave the waiting room before the visit starts. */
  cancel: portalProcedure
    .input(z.object({ visitId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const client = await sessionClient(ctx);
      const [visit] = await ctx.db
        .update(telehealthVisits)
        .set({ status: "cancelled", endedAt: new Date() })
        .where(
          and(
            eq(telehealthVisits.id, input.visitId),
            eq(telehealthVisits.practiceId, client.practiceId),
            eq(telehealthVisits.clientId, client.id),
            eq(telehealthVisits.status, "waiting"),
          ),
        )
        .returning({ id: telehealthVisits.id });
      return { cancelled: Boolean(visit) };
    }),
});
