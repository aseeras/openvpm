import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  appointments,
  communications,
  locationMessaging,
  practices,
} from "@openpims/db";
import { createRouter, protectedProcedure, requireRole } from "../trpc";
import { isAgentConfigured } from "@/lib/agent/runner";
import {
  formatLocal,
  loadAssistantPractice,
  phoneFromAssistantSubject,
  saveDraftText,
  sendClinicText,
} from "@/lib/texting-assistant/assistant";
import {
  TEXTING_ASSISTANT_INFO_MAX_LENGTH,
  TEXTING_ASSISTANT_INTRO_MAX_LENGTH,
  textingAssistantSettingsFrom,
} from "@/lib/texting-assistant/settings";

const adminProcedure = protectedProcedure.use(requireRole("admin"));
const inboxStaffProcedure = protectedProcedure.use(
  requireRole("admin", "veterinarian", "technician", "front_desk"),
);

const timeInput = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM");

const BOOKING_KEY_PREFIX = "assistant:booking:";

function notFound(message = "That request is no longer available.") {
  return new TRPCError({ code: "NOT_FOUND", message });
}

/**
 * Settings and staff actions for the texting assistant: approve or decline
 * the visits it holds, and send the replies it drafted.
 */
export const textingAssistantRouter = createRouter({
  getSettings: adminProcedure.query(async ({ ctx }) => {
    const [practice] = await ctx.db
      .select({ settings: practices.settings })
      .from(practices)
      .where(and(eq(practices.id, ctx.practiceId), isNull(practices.deletedAt)))
      .limit(1);
    const [messaging] = await ctx.db
      .select({ enabled: locationMessaging.enabled })
      .from(locationMessaging)
      .where(
        and(
          eq(locationMessaging.practiceId, ctx.practiceId),
          isNull(locationMessaging.deletedAt),
        ),
      )
      .limit(1);
    return {
      ...textingAssistantSettingsFrom(practice?.settings),
      aiConfigured: isAgentConfigured(),
      textingEnabled: messaging?.enabled === true,
    };
  }),

  updateSettings: adminProcedure
    .input(
      z
        .object({
          mode: z.enum(["off", "draft", "live"]),
          info: z.string().max(TEXTING_ASSISTANT_INFO_MAX_LENGTH),
          intro: z.string().trim().max(TEXTING_ASSISTANT_INTRO_MAX_LENGTH),
          sharePrices: z.boolean(),
          hours: z
            .object({
              days: z.array(z.number().int().min(0).max(6)).max(7),
              start: timeInput,
              end: timeInput,
            })
            .refine((hours) => hours.start < hours.end, {
              message: "Closing time must be after opening time.",
            }),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      const value = {
        mode: input.mode,
        info: input.info.trim(),
        intro: input.intro,
        sharePrices: input.sharePrices,
        hours: { ...input.hours, days: [...new Set(input.hours.days)].sort() },
      };
      const [updated] = await ctx.db
        .update(practices)
        .set({
          settings: sql`coalesce(${practices.settings}, '{}'::jsonb) || ${JSON.stringify(
            { textingAssistant: value },
          )}::jsonb`,
        })
        .where(
          and(eq(practices.id, ctx.practiceId), isNull(practices.deletedAt)),
        )
        .returning({ settings: practices.settings });
      if (!updated) throw notFound("Practice not found");
      return textingAssistantSettingsFrom(updated.settings);
    }),

  /** Send (optionally edited) a reply the assistant drafted. */
  sendDraft: inboxStaffProcedure
    .input(
      z.object({
        communicationId: z.string().guid(),
        content: z.string().trim().min(1).max(600).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [draft] = await ctx.db
        .select({
          id: communications.id,
          clientId: communications.clientId,
          subject: communications.subject,
          content: communications.content,
          dedupeKey: communications.dedupeKey,
        })
        .from(communications)
        .where(
          and(
            eq(communications.id, input.communicationId),
            eq(communications.practiceId, ctx.practiceId),
            eq(communications.status, "draft"),
            isNull(communications.deletedAt),
          ),
        )
        .limit(1);
      const to = phoneFromAssistantSubject(draft?.subject ?? null);
      if (!draft || !to)
        throw notFound("That draft was already sent or removed.");
      const result = await sendClinicText({
        practiceId: ctx.practiceId,
        to,
        body: input.content ?? draft.content ?? "",
        clientId: draft.clientId,
        subject: `Assistant reply to ${to} (sent by staff)`,
        dedupeKey: draft.dedupeKey ?? `assistant:sent:${draft.id}`,
        draftId: draft.id,
        sourceId: draft.id,
      });
      if (result.status === "failed") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `The text was not sent: ${result.error}`,
        });
      }
      return { status: result.status };
    }),

  discardDraft: inboxStaffProcedure
    .input(z.object({ communicationId: z.string().guid() }))
    .mutation(async ({ ctx, input }) => {
      const removed = await ctx.db
        .update(communications)
        .set({ deletedAt: new Date() })
        .where(
          and(
            eq(communications.id, input.communicationId),
            eq(communications.practiceId, ctx.practiceId),
            eq(communications.status, "draft"),
            isNull(communications.deletedAt),
          ),
        )
        .returning({ id: communications.id });
      if (removed.length === 0)
        throw notFound("That draft was already sent or removed.");
      return { ok: true };
    }),

  /**
   * Approve or decline a visit the assistant held. Approving confirms it;
   * declining cancels it and frees the time. Either way the client is told:
   * texted right away when the assistant is live, otherwise as a draft.
   */
  decideBooking: inboxStaffProcedure
    .input(
      z.object({
        communicationId: z.string().guid(),
        decision: z.enum(["approve", "decline"]),
        message: z.string().trim().max(600).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [note] = await ctx.db
        .select({
          id: communications.id,
          clientId: communications.clientId,
          subject: communications.subject,
          content: communications.content,
          dedupeKey: communications.dedupeKey,
        })
        .from(communications)
        .where(
          and(
            eq(communications.id, input.communicationId),
            eq(communications.practiceId, ctx.practiceId),
            isNull(communications.deletedAt),
          ),
        )
        .limit(1);
      const appointmentId = note?.dedupeKey?.startsWith(BOOKING_KEY_PREFIX)
        ? note.dedupeKey.slice(BOOKING_KEY_PREFIX.length)
        : null;
      const to = phoneFromAssistantSubject(note?.subject ?? null);
      if (!note || !appointmentId || !to) throw notFound();

      const approve = input.decision === "approve";
      const [appointment] = await ctx.db
        .update(appointments)
        .set({ status: approve ? "confirmed" : "cancelled" })
        .where(
          and(
            eq(appointments.id, appointmentId),
            eq(appointments.practiceId, ctx.practiceId),
            eq(appointments.status, "scheduled"),
            isNull(appointments.deletedAt),
          ),
        )
        .returning({
          id: appointments.id,
          startTime: appointments.startTime,
        });
      if (!appointment) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "This visit was already confirmed, cancelled or changed on the schedule.",
        });
      }

      const practice = await loadAssistantPractice(ctx.practiceId);
      const timeZone = practice?.timezone ?? "America/New_York";
      const when = formatLocal(appointment.startTime, timeZone);
      const body =
        input.message ||
        (approve
          ? `You're all set! We'll see you ${when}. If you need to change it, just reply here.`
          : `Sorry, we can't make ${when} work after all. Reply here and we'll find another time.`);

      await ctx.db
        .update(communications)
        .set({
          status: "read",
          readAt: new Date(),
          content: `${note.content ?? ""}\n\n${approve ? "Approved" : "Declined"} by ${
            ctx.user.name ?? "staff"
          }.`,
        })
        .where(
          and(
            eq(communications.id, note.id),
            eq(communications.practiceId, ctx.practiceId),
          ),
        );

      const dedupeKey = `assistant:decision:${appointment.id}`;
      const subject = approve
        ? `Visit confirmation to ${to}`
        : `Visit declined, text to ${to}`;
      if (practice?.settings.mode === "live") {
        const sent = await sendClinicText({
          practiceId: ctx.practiceId,
          to,
          body,
          clientId: note.clientId,
          subject,
          dedupeKey,
          sourceId: appointment.id,
        });
        return { texted: sent.status === "sent", error: sent.error ?? null };
      }
      await saveDraftText({
        practiceId: ctx.practiceId,
        clientId: note.clientId,
        subject: `Assistant draft reply to ${to}`,
        body,
        dedupeKey,
      });
      return { texted: false, error: null };
    }),
});
