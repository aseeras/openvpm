import { relations, sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
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
import { clients } from "./clients";
import { patients } from "./patients";
import { users } from "./users";
import { appointments } from "./scheduling";

export const telehealthVisitStatusEnum = pgEnum("telehealth_visit_status", [
  "waiting",
  "in_call",
  "completed",
  "cancelled",
  "declined",
]);

/**
 * A client-requested video visit for an established patient. The client
 * waits in a virtual waiting room until a clinician starts the call; the
 * video room exists only while the visit is in progress. Calls are not
 * recorded. With the client's consent the conversation can be transcribed
 * (text only); the transcript is kept here for the clinician's note.
 */
export const telehealthVisits = pgTable(
  "telehealth_visits",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id),
    status: telehealthVisitStatusEnum("status").notNull().default("waiting"),
    reason: varchar("reason", { length: 200 }).notNull(),
    notes: text("notes"),
    clinicianId: uuid("clinician_id").references(() => users.id),
    videoRoomName: varchar("video_room_name", { length: 128 }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    declineReason: varchar("decline_reason", { length: 300 }),
    /** The visit on the schedule, opened when the call starts. */
    appointmentId: uuid("appointment_id").references(() => appointments.id),
    transcriptStatus: varchar("transcript_status", { length: 16 })
      .notNull()
      .default("off"),
    transcript: text("transcript"),
    transcriptError: varchar("transcript_error", { length: 300 }),
  },
  (table) => ({
    queueIdx: index("telehealth_visits_queue_idx").on(
      table.practiceId,
      table.status,
      table.createdAt,
    ),
    clientIdx: index("telehealth_visits_client_idx").on(
      table.practiceId,
      table.clientId,
      table.createdAt,
    ),
    oneOpenVisitPerPatientUq: uniqueIndex(
      "telehealth_visits_one_open_per_patient_uq",
    )
      .on(table.practiceId, table.patientId)
      .where(sql`${table.status} in ('waiting', 'in_call')`),
    patientClientTenantFk: foreignKey({
      columns: [table.practiceId, table.patientId, table.clientId],
      foreignColumns: [patients.practiceId, patients.id, patients.clientId],
      name: "telehealth_visits_patient_client_tenant_fk",
    }),
    clinicianTenantFk: foreignKey({
      columns: [table.practiceId, table.clinicianId],
      foreignColumns: [users.practiceId, users.id],
      name: "telehealth_visits_clinician_tenant_fk",
    }),
    tenantIdentityUq: uniqueIndex("telehealth_visits_tenant_identity_uq").on(
      table.practiceId,
      table.id,
      table.clientId,
    ),
    appointmentTenantFk: foreignKey({
      columns: [table.practiceId, table.appointmentId, table.patientId],
      foreignColumns: [
        appointments.practiceId,
        appointments.id,
        appointments.patientId,
      ],
      name: "telehealth_visits_appointment_tenant_fk",
    }),
    transcriptStatusCheck: check(
      "telehealth_visits_transcript_status_check",
      sql`${table.transcriptStatus} in ('off', 'requested', 'declined', 'active', 'stopped', 'processing', 'ready', 'failed')
        and (${table.transcriptStatus} <> 'ready' or ${table.transcript} is not null)
        and (${table.transcript} is null or length(${table.transcript}) <= 200000)`,
    ),
    reasonCheck: check(
      "telehealth_visits_reason_check",
      sql`length(btrim(${table.reason})) between 1 and 200`,
    ),
    notesCheck: check(
      "telehealth_visits_notes_check",
      sql`${table.notes} is null or length(${table.notes}) <= 2000`,
    ),
    callShapeCheck: check(
      "telehealth_visits_call_shape_check",
      sql`${table.status} <> 'in_call' or (
        ${table.clinicianId} is not null
        and ${table.videoRoomName} is not null
        and ${table.startedAt} is not null
      )`,
    ),
  }),
);

/**
 * The client's answer when the clinician asks to transcribe a video visit.
 * Append-only evidence: the disclosure text the client saw is kept with its
 * version and the name they were signed in as.
 */
export const telehealthTranscriptConsents = pgTable(
  "telehealth_transcript_consents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    visitId: uuid("visit_id")
      .notNull()
      .references(() => telehealthVisits.id),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    action: varchar("action", { length: 16 }).notNull(),
    signerName: varchar("signer_name", { length: 255 }).notNull(),
    disclosureVersion: varchar("disclosure_version", { length: 32 }).notNull(),
    disclosure: text("disclosure").notNull(),
  },
  (table) => ({
    visitIdx: index("telehealth_transcript_consents_visit_idx").on(
      table.practiceId,
      table.visitId,
      table.createdAt,
    ),
    visitClientTenantFk: foreignKey({
      columns: [table.practiceId, table.visitId, table.clientId],
      foreignColumns: [
        telehealthVisits.practiceId,
        telehealthVisits.id,
        telehealthVisits.clientId,
      ],
      name: "telehealth_transcript_consents_visit_tenant_fk",
    }),
    actionCheck: check(
      "telehealth_transcript_consents_action_check",
      sql`${table.action} in ('granted', 'declined')`,
    ),
    textCheck: check(
      "telehealth_transcript_consents_text_check",
      sql`length(btrim(${table.signerName})) between 1 and 255
        and length(btrim(${table.disclosureVersion})) between 1 and 32
        and length(btrim(${table.disclosure})) between 1 and 4000`,
    ),
  }),
);

export const telehealthVisitsRelations = relations(
  telehealthVisits,
  ({ one }) => ({
    practice: one(practices, {
      fields: [telehealthVisits.practiceId],
      references: [practices.id],
    }),
    client: one(clients, {
      fields: [telehealthVisits.clientId],
      references: [clients.id],
    }),
    patient: one(patients, {
      fields: [telehealthVisits.patientId],
      references: [patients.id],
    }),
    clinician: one(users, {
      fields: [telehealthVisits.clinicianId],
      references: [users.id],
    }),
  }),
);
