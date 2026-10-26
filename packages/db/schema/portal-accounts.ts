import {
  foreignKey,
  index,
  integer,
  jsonb,
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
 * Username-and-password sign-in for the client portal. One account per
 * client; usernames are stored lowercase and are unique across the server
 * because sign-in happens before we know the practice.
 */
export const portalAccounts = pgTable(
  "portal_accounts",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    username: varchar("username", { length: 32 }).notNull(),
    passwordHash: varchar("password_hash", { length: 255 }).notNull(),
    failedAttempts: integer("failed_attempts").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastSignInAt: timestamp("last_sign_in_at", { withTimezone: true }),
  },
  (table) => ({
    usernameUq: uniqueIndex("portal_accounts_username_uq")
      .on(table.username)
      .where(sql`${table.deletedAt} is null`),
    oneAccountPerClientUq: uniqueIndex("portal_accounts_client_uq")
      .on(table.practiceId, table.clientId)
      .where(sql`${table.deletedAt} is null`),
    clientTenantFk: foreignKey({
      columns: [table.practiceId, table.clientId],
      foreignColumns: [clients.practiceId, clients.id],
      name: "portal_accounts_client_tenant_fk",
    }),
  }),
);

/**
 * Short-lived emailed codes that prove the person owns an email address,
 * for creating an account and for resetting a password. Only a digest of the
 * code is stored; pending sign-up details wait here until the code is used.
 */
export const portalEmailCodes = pgTable(
  "portal_email_codes",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    purpose: varchar("purpose", { length: 16 }).notNull(),
    email: varchar("email", { length: 255 }).notNull(),
    codeHash: varchar("code_hash", { length: 64 }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  },
  (table) => ({
    emailIdx: index("portal_email_codes_email_idx").on(
      table.practiceId,
      table.email,
      table.createdAt,
    ),
  }),
);

export const portalAccountsRelations = relations(portalAccounts, ({ one }) => ({
  practice: one(practices, {
    fields: [portalAccounts.practiceId],
    references: [practices.id],
  }),
  client: one(clients, {
    fields: [portalAccounts.clientId],
    references: [clients.id],
  }),
}));
