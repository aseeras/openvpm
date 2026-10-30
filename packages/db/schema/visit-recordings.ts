import { relations, sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { baseColumns } from "./common";
import { practices } from "./practices";
import { patients } from "./patients";
import { users } from "./users";
import { appointments } from "./scheduling";

export const visitRecordingConsentActionEnum = pgEnum(
  "visit_recording_consent_action",
  ["granted", "declined"],
);

export const visitRecordingStatusEnum = pgEnum("visit_recording_status", [
  "awaiting_audio",
  "transcribing",
  "transcribed",
  "failed",
  "discarded",
]);

/**
 * Immutable evidence of the client's answer when staff ask to record a visit.
 * Append-only (the app role may only SELECT and INSERT): the disclosure text
 * the client saw is snapshotted with its version, alongside the name the
 * client gave and the staff member who presented the request.
 */
export const visitRecordingConsents = pgTable(
  "visit_recording_consents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id),
    appointmentId: uuid("appointment_id")
      .notNull()
      .references(() => appointments.id),
    action: visitRecordingConsentActionEnum("action").notNull(),
    signerName: varchar("signer_name", { length: 255 }).notNull(),
    disclosureVersion: varchar("disclosure_version", { length: 32 }).notNull(),
    disclosure: text("disclosure").notNull(),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id),
    actorName: varchar("actor_name", { length: 255 }).notNull(),
  },
  (table) => ({
    tenantIdentityUq: uniqueIndex(
      "visit_recording_consents_tenant_identity_uq",
    ).on(table.practiceId, table.id, table.appointmentId),
    appointmentHistoryIdx: index(
      "visit_recording_consents_appointment_history_idx",
    ).on(table.practiceId, table.appointmentId, table.occurredAt, table.id),
    appointmentPatientTenantFk: foreignKey({
      columns: [table.practiceId, table.appointmentId, table.patientId],
      foreignColumns: [
        appointments.practiceId,
        appointments.id,
        appointments.patientId,
      ],
      name: "visit_recording_consents_appointment_patient_tenant_fk",
    }),
    actorTenantFk: foreignKey({
      columns: [table.practiceId, table.actorUserId],
      foreignColumns: [users.practiceId, users.id],
      name: "visit_recording_consents_actor_tenant_fk",
    }),
    signerNameCheck: check(
      "visit_recording_consents_signer_name_check",
      sql`length(btrim(${table.signerName})) between 1 and 255`,
    ),
    disclosureCheck: check(
      "visit_recording_consents_disclosure_check",
      sql`length(btrim(${table.disclosureVersion})) between 1 and 32
        and length(btrim(${table.disclosure})) between 1 and 4000`,
    ),
    actorNameCheck: check(
      "visit_recording_consents_actor_name_check",
      sql`length(btrim(${table.actorName})) between 1 and 255`,
    ),
  }),
);

/**
 * One audio recording of a visit, from upload through transcription. The
 * audio is a transient object: it is deleted from storage once Amazon
 * Transcribe returns (or fails), and the transcript feeds an AI SOAP draft
 * that the clinician reviews before anything enters the medical record.
 */
export const visitRecordings = pgTable(
  "visit_recordings",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id),
    appointmentId: uuid("appointment_id")
      .notNull()
      .references(() => appointments.id),
    consentId: uuid("consent_id")
      .notNull()
      .references(() => visitRecordingConsents.id),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    status: visitRecordingStatusEnum("status")
      .notNull()
      .default("awaiting_audio"),
    audioObjectKey: varchar("audio_object_key", { length: 512 }),
    audioObjectVersionId: varchar("audio_object_version_id", { length: 1024 }),
    audioContentType: varchar("audio_content_type", { length: 64 }),
    audioBytes: integer("audio_bytes"),
    audioDeletedAt: timestamp("audio_deleted_at", { withTimezone: true }),
    transcriptionJobName: varchar("transcription_job_name", { length: 200 }),
    transcript: text("transcript"),
    transcribedAt: timestamp("transcribed_at", { withTimezone: true }),
    failureReason: varchar("failure_reason", { length: 500 }),
  },
  (table) => ({
    appointmentIdx: index("visit_recordings_appointment_idx").on(
      table.practiceId,
      table.appointmentId,
      table.createdAt,
    ),
    transcriptionJobUq: uniqueIndex("visit_recordings_transcription_job_uq")
      .on(table.transcriptionJobName)
      .where(sql`${table.transcriptionJobName} is not null`),
    appointmentPatientTenantFk: foreignKey({
      columns: [table.practiceId, table.appointmentId, table.patientId],
      foreignColumns: [
        appointments.practiceId,
        appointments.id,
        appointments.patientId,
      ],
      name: "visit_recordings_appointment_patient_tenant_fk",
    }),
    consentTenantFk: foreignKey({
      columns: [table.practiceId, table.consentId, table.appointmentId],
      foreignColumns: [
        visitRecordingConsents.practiceId,
        visitRecordingConsents.id,
        visitRecordingConsents.appointmentId,
      ],
      name: "visit_recordings_consent_tenant_fk",
    }),
    creatorTenantFk: foreignKey({
      columns: [table.practiceId, table.createdBy],
      foreignColumns: [users.practiceId, users.id],
      name: "visit_recordings_creator_tenant_fk",
    }),
    audioBytesCheck: check(
      "visit_recordings_audio_bytes_check",
      sql`${table.audioBytes} is null or ${table.audioBytes} > 0`,
    ),
    transcriptShapeCheck: check(
      "visit_recordings_transcript_shape_check",
      sql`(${table.status} = 'transcribed') = (${table.transcript} is not null and ${table.transcribedAt} is not null)`,
    ),
  }),
);

export const visitRecordingConsentsRelations = relations(
  visitRecordingConsents,
  ({ one }) => ({
    practice: one(practices, {
      fields: [visitRecordingConsents.practiceId],
      references: [practices.id],
    }),
    appointment: one(appointments, {
      fields: [visitRecordingConsents.appointmentId],
      references: [appointments.id],
    }),
  }),
);

export const visitRecordingsRelations = relations(
  visitRecordings,
  ({ one }) => ({
    practice: one(practices, {
      fields: [visitRecordings.practiceId],
      references: [practices.id],
    }),
    appointment: one(appointments, {
      fields: [visitRecordings.appointmentId],
      references: [appointments.id],
    }),
    consent: one(visitRecordingConsents, {
      fields: [visitRecordings.consentId],
      references: [visitRecordingConsents.id],
    }),
  }),
);
