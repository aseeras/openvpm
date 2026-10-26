import { and, eq, isNull, sql } from "drizzle-orm";
import { appointments } from "@openpims/db";
import type { Database } from "@openpims/db/client";

/** What a client can pick when asking for a video visit. */
export const TELEHEALTH_REASONS = [
  "Acupuncture follow-up",
  "Stiffness or mobility",
  "Medication question",
  "Skin or itching",
  "Appetite change",
  "Something else",
] as const;
export type TelehealthReason = (typeof TELEHEALTH_REASONS)[number];

export const TELEHEALTH_NOTES_MAX_LENGTH = 1000;

/** How often the waiting room and the clinician queue refresh. */
export const TELEHEALTH_POLL_INTERVAL_MS = 4000;

export interface TelehealthSettings {
  /** The clinic is taking video visits right now. */
  accepting: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Malformed or missing settings mean "not accepting". */
export function telehealthSettings(
  practiceSettings: unknown,
): TelehealthSettings {
  const candidate = isRecord(practiceSettings)
    ? practiceSettings.telehealth
    : undefined;
  return { accepting: isRecord(candidate) && candidate.accepting === true };
}

/**
 * Video visits are for established patients only: a veterinarian-client-
 * patient relationship cannot be started remotely, so the pet needs at least
 * one completed visit with the practice.
 */
export function establishedPatientPredicate(
  practiceId: string,
  patientIdColumn: unknown,
) {
  return sql`exists (
    select 1 from ${appointments}
    where ${appointments.practiceId} = ${practiceId}
      and ${appointments.patientId} = ${patientIdColumn}
      and ${appointments.status} = 'checked_out'
      and ${appointments.deletedAt} is null
  )`;
}

export async function isEstablishedPatient(
  db: Database,
  practiceId: string,
  patientId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: appointments.id })
    .from(appointments)
    .where(
      and(
        eq(appointments.practiceId, practiceId),
        eq(appointments.patientId, patientId),
        eq(appointments.status, "checked_out"),
        isNull(appointments.deletedAt),
      ),
    )
    .limit(1);
  return Boolean(row);
}
