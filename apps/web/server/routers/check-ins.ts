import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import {
  appointmentCheckIns,
  appointments,
  clients,
  communications,
  emailSuppressions,
  patients,
  practices,
} from "@openpims/db";
import { createRouter, protectedProcedure, requireRole } from "../trpc";
import { checkInIsOpen, checkInUrl } from "@/lib/check-in/link";
import {
  latestPatientCheckIn,
  listPatientCheckIns,
} from "@/lib/check-in/store";
import { formatCheckInForClinicalContext } from "@/lib/check-in/form";
import { sendCheckInFormEmail } from "@/lib/email";
import {
  emailSuppressionSendBlockMessage,
  normalizeEmailSuppressionAddress,
} from "@/lib/email-suppression";
import { rateLimit } from "@/lib/rate-limit";

const staffRole = requireRole(
  "admin",
  "veterinarian",
  "technician",
  "front_desk",
);

function formatVisitDateTime(
  startTime: Date,
  timeZone: string | null,
): { appointmentDate: string; appointmentTime: string } {
  const zone = timeZone?.trim() || undefined;
  try {
    return {
      appointmentDate: startTime.toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        timeZone: zone,
      }),
      appointmentTime: startTime.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        timeZone: zone,
      }),
    };
  } catch {
    return {
      appointmentDate: startTime.toDateString(),
      appointmentTime: startTime.toTimeString().slice(0, 5),
    };
  }
}

/**
 * Staff side of the owner pre-appointment check-in form: read answers on the
 * chart, mark them reviewed, and copy or email the owner's form link.
 */
export const checkInsRouter = createRouter({
  listForPatient: protectedProcedure
    .input(z.object({ patientId: z.string().guid() }))
    .query(async ({ ctx, input }) => {
      const rows = await listPatientCheckIns(
        ctx.db,
        ctx.practiceId,
        input.patientId,
        10,
      );
      return rows.map((row) => ({
        ...row,
        summary: formatCheckInForClinicalContext(row.answers),
      }));
    }),

  /** Latest answers as plain text, for clinical tools such as the holistic workup. */
  latestSummaryForPatient: protectedProcedure
    .input(z.object({ patientId: z.string().guid() }))
    .query(async ({ ctx, input }) => {
      const row = await latestPatientCheckIn(
        ctx.db,
        ctx.practiceId,
        input.patientId,
      );
      if (!row) return null;
      return {
        submittedAt: row.submittedAt,
        appointmentStart: row.appointmentStart,
        summary: formatCheckInForClinicalContext(row.answers),
      };
    }),

  /** Link status for one visit (encounter page and appointment details). */
  forAppointment: protectedProcedure
    .input(z.object({ appointmentId: z.string().guid() }))
    .query(async ({ ctx, input }) => {
      const [appt] = await ctx.db
        .select({
          id: appointments.id,
          status: appointments.status,
          startTime: appointments.startTime,
          patientId: appointments.patientId,
          clientId: appointments.clientId,
          clientEmail: clients.email,
        })
        .from(appointments)
        .leftJoin(
          clients,
          and(
            eq(clients.id, appointments.clientId),
            eq(clients.practiceId, appointments.practiceId),
          ),
        )
        .where(
          and(
            eq(appointments.practiceId, ctx.practiceId),
            eq(appointments.id, input.appointmentId),
            isNull(appointments.deletedAt),
          ),
        )
        .limit(1);
      if (!appt) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Visit not found" });
      }
      const [saved] = await ctx.db
        .select({
          submittedAt: appointmentCheckIns.submittedAt,
          reviewedAt: appointmentCheckIns.reviewedAt,
        })
        .from(appointmentCheckIns)
        .where(
          and(
            eq(appointmentCheckIns.practiceId, ctx.practiceId),
            eq(appointmentCheckIns.appointmentId, appt.id),
            isNull(appointmentCheckIns.deletedAt),
          ),
        )
        .limit(1);
      const eligible = Boolean(appt.patientId && appt.clientId);
      const open = eligible && checkInIsOpen(appt);
      return {
        eligible,
        open,
        url: open ? checkInUrl(appt.id) : null,
        canEmail: open && Boolean(appt.clientEmail?.trim()),
        submittedAt: saved?.submittedAt ?? null,
        reviewedAt: saved?.reviewedAt ?? null,
      };
    }),

  markReviewed: protectedProcedure
    .use(requireRole("admin", "veterinarian", "technician"))
    .input(z.object({ checkInId: z.string().guid() }))
    .mutation(async ({ ctx, input }) => {
      const [row] = await ctx.db
        .update(appointmentCheckIns)
        .set({ reviewedAt: new Date(), reviewedBy: ctx.user.id })
        .where(
          and(
            eq(appointmentCheckIns.practiceId, ctx.practiceId),
            eq(appointmentCheckIns.id, input.checkInId),
            isNull(appointmentCheckIns.deletedAt),
          ),
        )
        .returning({ id: appointmentCheckIns.id });
      if (!row) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Check-in not found",
        });
      }
      return { ok: true };
    }),

  /** Email the owner the check-in link for one upcoming visit. */
  sendLink: protectedProcedure
    .use(staffRole)
    .input(z.object({ appointmentId: z.string().guid() }))
    .mutation(async ({ ctx, input }) => {
      const limited = await rateLimit({
        key: `check-in-send:${ctx.practiceId}:${input.appointmentId}`,
        limit: 5,
        windowMs: 60 * 60 * 1000,
      });
      if (!limited.success) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "This link was just sent. Try again later.",
        });
      }

      const [row] = await ctx.db
        .select({
          id: appointments.id,
          status: appointments.status,
          startTime: appointments.startTime,
          clientId: appointments.clientId,
          clientFirstName: clients.firstName,
          clientLastName: clients.lastName,
          clientEmail: clients.email,
          patientName: patients.name,
          practiceName: practices.name,
          practicePhone: practices.phone,
          practiceTimezone: practices.timezone,
        })
        .from(appointments)
        .innerJoin(
          clients,
          and(
            eq(clients.id, appointments.clientId),
            eq(clients.practiceId, appointments.practiceId),
            isNull(clients.deletedAt),
          ),
        )
        .innerJoin(
          patients,
          and(
            eq(patients.id, appointments.patientId),
            eq(patients.practiceId, appointments.practiceId),
            isNull(patients.deletedAt),
          ),
        )
        .innerJoin(practices, eq(practices.id, appointments.practiceId))
        .where(
          and(
            eq(appointments.practiceId, ctx.practiceId),
            eq(appointments.id, input.appointmentId),
            isNull(appointments.deletedAt),
          ),
        )
        .limit(1);
      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Visit not found" });
      }
      if (!checkInIsOpen(row)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "This visit has already started, finished, or been cancelled.",
        });
      }
      const to = normalizeEmailSuppressionAddress(row.clientEmail);
      if (!to) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "This client has no email address. Copy the link and text it instead.",
        });
      }
      const [suppressed] = await ctx.db
        .select({ reason: emailSuppressions.reason })
        .from(emailSuppressions)
        .where(
          and(
            eq(emailSuppressions.practiceId, ctx.practiceId),
            eq(emailSuppressions.email, to),
            isNull(emailSuppressions.deletedAt),
          ),
        )
        .limit(1);
      if (suppressed) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: emailSuppressionSendBlockMessage(suppressed.reason),
        });
      }

      const url = checkInUrl(row.id);
      const when = formatVisitDateTime(row.startTime, row.practiceTimezone);
      const result = await sendCheckInFormEmail({
        to,
        clientName: row.clientFirstName,
        patientName: row.patientName,
        practiceName: row.practiceName,
        practicePhone: row.practicePhone ?? undefined,
        checkInUrl: url,
        ...when,
      });

      await ctx.db.insert(communications).values({
        practiceId: ctx.practiceId,
        clientId: row.clientId!,
        channel: "email",
        direction: "outbound",
        subject: `Check-in form for ${row.patientName}`,
        content: `Sent the pre-appointment check-in form link for ${row.patientName}'s visit on ${when.appointmentDate} at ${when.appointmentTime}.`,
        status: result.success ? "sent" : "failed",
      });

      if (!result.success) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "The email could not be sent. Copy the link instead.",
        });
      }
      return { ok: true, sentTo: to };
    }),
});
