import {
  foreignKey,
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { baseColumns } from "./common";
import { clients } from "./clients";
import { practices } from "./practices";

/**
 * Third-party sign-ins (Sign in with Apple) linked to a client-portal client.
 * The provider's stable user id is stored, never a password or token.
 * Unlinking soft-deletes the row so the history stays.
 */
export const portalSignInIdentities = pgTable(
  "portal_sign_in_identities",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    provider: varchar("provider", { length: 16 }).notNull(),
    subject: varchar("subject", { length: 255 }).notNull(),
    email: varchar("email", { length: 320 }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (table) => ({
    activeSubjectUq: uniqueIndex("portal_sign_in_identities_subject_uq")
      .on(table.practiceId, table.provider, table.subject)
      .where(sql`${table.deletedAt} is null`),
    lookupIdx: index("portal_sign_in_identities_lookup_idx").on(
      table.provider,
      table.subject,
    ),
    clientIdx: index("portal_sign_in_identities_client_idx").on(
      table.practiceId,
      table.clientId,
    ),
    clientTenantFk: foreignKey({
      columns: [table.practiceId, table.clientId],
      foreignColumns: [clients.practiceId, clients.id],
      name: "portal_sign_in_identities_client_tenant_fk",
    }),
  }),
);

export const portalSignInIdentitiesRelations = relations(
  portalSignInIdentities,
  ({ one }) => ({
    practice: one(practices, {
      fields: [portalSignInIdentities.practiceId],
      references: [practices.id],
    }),
    client: one(clients, {
      fields: [portalSignInIdentities.clientId],
      references: [clients.id],
    }),
  }),
);
