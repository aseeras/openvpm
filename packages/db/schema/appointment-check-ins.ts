import {
  foreignKey,
  index,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { baseColumns } from "./common";
import { appointments } from "./scheduling";
import { clients } from "./clients";
import { patients } from "./patients";
import { practices } from "./practices";
import { users } from "./users";

/**
 * Owner-completed pre-appointment check-in form: the pet's current problems,
 * daily habits, food, medications and supplements, and the owner's goals.
 *
 * One row per appointment. Answers are owner-reported and stay separate from
 * verified clinical records (allergies, medications); staff review them and
 * copy anything authoritative into the chart themselves.
 */
export const appointmentCheckIns = pgTable(
  "appointment_check_ins",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    appointmentId: uuid("appointment_id")
      .notNull()
      .references(() => appointments.id),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    /** Versioned answer document; see apps/web/lib/check-in/form.ts. */
    answers: jsonb("answers")
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** "link" (emailed/texted link) or "portal" (signed-in client portal). */
    submittedVia: varchar("submitted_via", { length: 16 }).notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedBy: uuid("reviewed_by").references(() => users.id),
  },
  (table) => ({
    appointmentUq: uniqueIndex("appointment_check_ins_appointment_uq")
      .on(table.practiceId, table.appointmentId)
      .where(sql`${table.deletedAt} is null`),
    patientIdx: index("appointment_check_ins_patient_idx").on(
      table.practiceId,
      table.patientId,
      table.submittedAt,
    ),
    appointmentTenantFk: foreignKey({
      columns: [table.practiceId, table.appointmentId],
      foreignColumns: [appointments.practiceId, appointments.id],
      name: "appointment_check_ins_appointment_tenant_fk",
    }),
    patientTenantFk: foreignKey({
      columns: [table.practiceId, table.patientId],
      foreignColumns: [patients.practiceId, patients.id],
      name: "appointment_check_ins_patient_tenant_fk",
    }),
    clientTenantFk: foreignKey({
      columns: [table.practiceId, table.clientId],
      foreignColumns: [clients.practiceId, clients.id],
      name: "appointment_check_ins_client_tenant_fk",
    }),
  }),
);
