import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  appointmentCheckIns,
  appointments,
  appointmentTypes,
  clients,
  patients,
  practices,
} from "@openpims/db";
import type { Database } from "@openpims/db/client";
import { queueInboxAlert } from "@/lib/communications/inbox-alert";
import {
  checkInHasRequiredAnswers,
  readStoredCheckInAnswers,
  toStoredCheckInAnswers,
  type CheckInAnswers,
} from "./form";
import { checkInIsOpen } from "./link";

export type CheckInVisit = {
  appointmentId: string;
  practiceId: string;
  patientId: string;
  clientId: string;
  status: string;
  startTime: Date;
  patientName: string;
  patientSpecies: string | null;
  clientFirstName: string;
  practiceName: string;
  practiceTimezone: string | null;
  visitTypeName: string | null;
  open: boolean;
  submittedAt: Date | null;
  answers: CheckInAnswers;
};

/**
 * Load the visit and any saved answers. Runs inside a tenant (or system)
 * transaction; returns null when the appointment, its pet, its client, or the
 * practice is missing or deleted so callers can give one generic "not found".
 */
export async function loadCheckInVisit(
  tx: Database,
  appointmentId: string,
  now: Date = new Date(),
): Promise<CheckInVisit | null> {
  const [row] = await tx
    .select({
      appointmentId: appointments.id,
      practiceId: appointments.practiceId,
      patientId: appointments.patientId,
      clientId: appointments.clientId,
      status: appointments.status,
      startTime: appointments.startTime,
      appointmentDeletedAt: appointments.deletedAt,
      patientName: patients.name,
      patientSpecies: patients.species,
      clientFirstName: clients.firstName,
      practiceName: practices.name,
      practiceTimezone: practices.timezone,
      practiceRecoveryHold: practices.recoveryHold,
      visitTypeName: appointmentTypes.name,
    })
    .from(appointments)
    .innerJoin(
      practices,
      and(
        eq(practices.id, appointments.practiceId),
        isNull(practices.deletedAt),
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
    .innerJoin(
      clients,
      and(
        eq(clients.id, appointments.clientId),
        eq(clients.practiceId, appointments.practiceId),
        isNull(clients.deletedAt),
      ),
    )
    .leftJoin(
      appointmentTypes,
      and(
        eq(appointmentTypes.id, appointments.typeId),
        eq(appointmentTypes.practiceId, appointments.practiceId),
      ),
    )
    .where(eq(appointments.id, appointmentId))
    .limit(1);
  if (!row || !row.patientId || !row.clientId || row.appointmentDeletedAt) {
    return null;
  }

  const [saved] = await tx
    .select({
      answers: appointmentCheckIns.answers,
      submittedAt: appointmentCheckIns.submittedAt,
    })
    .from(appointmentCheckIns)
    .where(
      and(
        eq(appointmentCheckIns.practiceId, row.practiceId),
        eq(appointmentCheckIns.appointmentId, row.appointmentId),
        isNull(appointmentCheckIns.deletedAt),
      ),
    )
    .limit(1);

  return {
    appointmentId: row.appointmentId,
    practiceId: row.practiceId,
    patientId: row.patientId,
    clientId: row.clientId,
    status: row.status,
    startTime: row.startTime,
    patientName: row.patientName,
    patientSpecies: row.patientSpecies,
    clientFirstName: row.clientFirstName,
    practiceName: row.practiceName,
    practiceTimezone: row.practiceTimezone,
    visitTypeName: row.visitTypeName,
    open:
      !row.practiceRecoveryHold &&
      checkInIsOpen(
        { status: row.status, startTime: row.startTime, deletedAt: null },
        now,
      ),
    submittedAt: saved?.submittedAt ?? null,
    answers: saved ? readStoredCheckInAnswers(saved.answers) : {},
  };
}

export class CheckInClosedError extends Error {
  constructor() {
    super("This check-in form is closed.");
  }
}

export class CheckInIncompleteError extends Error {
  constructor() {
    super("Please tell us what you'd like help with.");
  }
}

/**
 * Save (or replace) the owner's answers for one visit. Re-submitting before
 * the visit overwrites the earlier answers and clears any staff review mark so
 * the team sees there is something new. Alerts the clinic inbox email.
 */
export async function saveCheckIn(
  ctx: {
    db: Database;
    postCommitEffect?: (effect: (rootDb: Database) => Promise<void>) => void;
  },
  visit: CheckInVisit,
  answers: CheckInAnswers,
  via: "link" | "portal",
): Promise<{ submittedAt: Date; firstSubmission: boolean }> {
  if (!visit.open) throw new CheckInClosedError();
  if (!checkInHasRequiredAnswers(answers)) throw new CheckInIncompleteError();

  const tx = ctx.db;
  // Serialize concurrent submissions for the same visit.
  await tx.execute(
    sql`select ${appointments.id} from ${appointments} where ${appointments.practiceId} = ${visit.practiceId} and ${appointments.id} = ${visit.appointmentId} for update`,
  );

  const stored = toStoredCheckInAnswers(answers);
  const now = new Date();
  const [existing] = await tx
    .select({ id: appointmentCheckIns.id })
    .from(appointmentCheckIns)
    .where(
      and(
        eq(appointmentCheckIns.practiceId, visit.practiceId),
        eq(appointmentCheckIns.appointmentId, visit.appointmentId),
        isNull(appointmentCheckIns.deletedAt),
      ),
    )
    .limit(1);

  if (existing) {
    await tx
      .update(appointmentCheckIns)
      .set({
        answers: stored,
        submittedVia: via,
        submittedAt: now,
        reviewedAt: null,
        reviewedBy: null,
      })
      .where(
        and(
          eq(appointmentCheckIns.practiceId, visit.practiceId),
          eq(appointmentCheckIns.id, existing.id),
        ),
      );
  } else {
    await tx.insert(appointmentCheckIns).values({
      practiceId: visit.practiceId,
      appointmentId: visit.appointmentId,
      patientId: visit.patientId,
      clientId: visit.clientId,
      answers: stored,
      submittedVia: via,
      submittedAt: now,
    });
  }

  await queueInboxAlert(ctx, visit.practiceId, {
    subject: `${existing ? "Updated check-in" : "Check-in form"} for ${visit.patientName}`,
    content: `${visit.clientFirstName} ${existing ? "updated" : "filled out"} the pre-appointment check-in form for ${visit.patientName}. Open ${visit.patientName}'s chart to read it.`,
  });

  return { submittedAt: now, firstSubmission: !existing };
}

export type PatientCheckInRow = {
  id: string;
  appointmentId: string;
  appointmentStart: Date;
  appointmentStatus: string;
  submittedAt: Date;
  submittedVia: string;
  reviewedAt: Date | null;
  answers: CheckInAnswers;
};

/** Most recent check-ins for one patient, newest first (staff chart). */
export async function listPatientCheckIns(
  tx: Database,
  practiceId: string,
  patientId: string,
  limit = 5,
): Promise<PatientCheckInRow[]> {
  const rows = await tx
    .select({
      id: appointmentCheckIns.id,
      appointmentId: appointmentCheckIns.appointmentId,
      appointmentStart: appointments.startTime,
      appointmentStatus: appointments.status,
      submittedAt: appointmentCheckIns.submittedAt,
      submittedVia: appointmentCheckIns.submittedVia,
      reviewedAt: appointmentCheckIns.reviewedAt,
      answers: appointmentCheckIns.answers,
    })
    .from(appointmentCheckIns)
    .innerJoin(
      appointments,
      and(
        eq(appointments.id, appointmentCheckIns.appointmentId),
        eq(appointments.practiceId, appointmentCheckIns.practiceId),
      ),
    )
    .where(
      and(
        eq(appointmentCheckIns.practiceId, practiceId),
        eq(appointmentCheckIns.patientId, patientId),
        isNull(appointmentCheckIns.deletedAt),
      ),
    )
    .orderBy(desc(appointmentCheckIns.submittedAt))
    .limit(limit);
  return rows.map((row) => ({
    ...row,
    answers: readStoredCheckInAnswers(row.answers),
  }));
}

/** Latest check-in for a patient, for clinical tools that want context. */
export async function latestPatientCheckIn(
  tx: Database,
  practiceId: string,
  patientId: string,
): Promise<PatientCheckInRow | null> {
  const [row] = await listPatientCheckIns(tx, practiceId, patientId, 1);
  return row ?? null;
}
