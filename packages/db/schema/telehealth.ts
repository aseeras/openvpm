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
 * recorded.
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
