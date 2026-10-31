import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "../../../../../packages/db/schema/index";
import type { Database } from "@openpims/db/client";
import { signInWithProviderIdentity, type ProviderIdentity } from "../identity-sign-in";
import { hashPortalSessionToken } from "../tokens";

/**
 * Sign in with Apple (and Google) against a real, freshly migrated database:
 * someone signing in for the first time gets a client portal account, and
 * coming back signs in to that same account.
 */

const repoRoot = resolve(process.cwd(), "../..");
const describeWithPostgres = process.env.PORTAL_SSO_DB_INTEGRATION === "1" ? describe : describe.skip;

describeWithPostgres("portal sign-in with Apple or Google (PostgreSQL)", () => {
  const databaseName = `openpims_portal_sso_${randomUUID().replaceAll("-", "")}`;
  let adminSql: ReturnType<typeof postgres>;
  let ownerSql: ReturnType<typeof postgres>;
  let db: Database;
  let clinicId: string;

  const now = new Date("2026-10-31T12:00:00Z");
  const signIn = (identity: ProviderIdentity, names: { givenName?: string; familyName?: string } = {}) =>
    signInWithProviderIdentity(db, {
      provider: "apple",
      identity,
      ...names,
      ip: "203.0.113.7",
      userAgent: "vitest",
      now,
    });

  async function sessionClient(rawToken: string | null) {
    expect(rawToken).toEqual(expect.any(String));
    const [session] = await db
      .select({ clientId: schema.portalSessions.clientId, practiceId: schema.portalSessions.practiceId })
      .from(schema.portalSessions)
      .where(eq(schema.portalSessions.tokenHash, hashPortalSessionToken(rawToken!)));
    expect(session).toBeDefined();
    const [client] = await db.select().from(schema.clients).where(eq(schema.clients.id, session!.clientId));
    return client!;
  }

  async function identitiesFor(subject: string) {
    return db
      .select()
      .from(schema.portalSignInIdentities)
      .where(and(eq(schema.portalSignInIdentities.subject, subject), isNull(schema.portalSignInIdentities.deletedAt)));
  }

  beforeAll(async () => {
    const adminUrl = process.env.DATABASE_URL;
    if (!adminUrl) throw new Error("DATABASE_URL is required");
    if (!/^openpims_portal_sso_[a-f0-9]+$/.test(databaseName)) throw new Error("unsafe disposable database name");
    const databaseUrl = new URL(adminUrl);
    databaseUrl.pathname = `/${databaseName}`;
    databaseUrl.search = "";
    databaseUrl.hash = "";

    adminSql = postgres(adminUrl, { max: 1 });
    await adminSql.unsafe(`create database "${databaseName}"`);
    execFileSync("pnpm", ["--filter", "@openpims/db", "db:migrate"], {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl.toString() },
      encoding: "utf8",
      timeout: 60_000,
    });
    ownerSql = postgres(databaseUrl.toString(), { max: 1 });
    db = drizzle(ownerSql, { schema }) as unknown as Database;
    const [clinic] = await db
      .insert(schema.practices)
      .values({ name: "Synthetic Sign-In Clinic" })
      .returning({ id: schema.practices.id });
    clinicId = clinic!.id;
  }, 90_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await ownerSql?.end();
    if (adminSql) {
      await adminSql.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await adminSql.end();
    }
  });

  it("creates a client portal account the first time a new Apple ID signs in", async () => {
    vi.stubEnv("PORTAL_SIGNUP_PRACTICE_ID", "");
    const identity = { subject: "apple-new-1", email: "New.Owner@Example.com", emailVerified: true };
    const client = await sessionClient(await signIn(identity, { givenName: "Robin", familyName: "Ng" }));
    expect(client).toMatchObject({ practiceId: clinicId, firstName: "Robin", lastName: "Ng", email: "new.owner@example.com" });

    const [linked] = await identitiesFor("apple-new-1");
    expect(linked).toMatchObject({ clientId: client.id, provider: "apple" });

    // Apple sends the name only the first time; coming back signs in to the same account.
    const again = await sessionClient(await signIn(identity));
    expect(again.id).toBe(client.id);
    expect(await identitiesFor("apple-new-1")).toHaveLength(1);
    const owners = await db.select().from(schema.clients).where(eq(schema.clients.email, "new.owner@example.com"));
    expect(owners).toHaveLength(1);
  });

  it("starts a fresh account when the Apple ID's old account was archived", async () => {
    const identity = { subject: "apple-archived", email: "archived@example.com", emailVerified: true };
    const first = await sessionClient(await signIn(identity, { givenName: "Lee" }));
    await db.update(schema.clients).set({ deletedAt: now }).where(eq(schema.clients.id, first.id));

    const second = await sessionClient(await signIn(identity));
    expect(second.id).not.toBe(first.id);
    expect(second.email).toBe("archived@example.com");
    const live = await identitiesFor("apple-archived");
    expect(live).toHaveLength(1);
    expect(live[0]!.clientId).toBe(second.id);
  });

  it("names the account after Apple when Apple doesn't share a name", async () => {
    const client = await sessionClient(
      await signIn({ subject: "apple-new-2", email: "abc123@privaterelay.appleid.com", emailVerified: true }),
    );
    expect(client).toMatchObject({ firstName: "Apple", lastName: "user", email: "abc123@privaterelay.appleid.com" });
  });

  it("creates an account even when Apple shares no email", async () => {
    const identity = { subject: "apple-no-email", email: null, emailVerified: false };
    const client = await sessionClient(await signIn(identity, { givenName: "Kai" }));
    expect(client).toMatchObject({ practiceId: clinicId, firstName: "Kai", email: null });
    expect((await sessionClient(await signIn(identity))).id).toBe(client.id);
  });

  it("never treats an unverified email as proof of an existing client", async () => {
    const [existing] = await db
      .insert(schema.clients)
      .values({ practiceId: clinicId, firstName: "Pat", lastName: "Owner", email: "pat@example.com" })
      .returning();
    const client = await sessionClient(
      await signIn({ subject: "apple-unverified", email: "pat@example.com", emailVerified: false }),
    );
    expect(client.id).not.toBe(existing!.id);
    expect(client.email).toBeNull();
  });

  it("connects to the clinic's existing client when the verified email matches", async () => {
    const [existing] = await db
      .insert(schema.clients)
      .values({ practiceId: clinicId, firstName: "Jo", lastName: "Rivera", email: "jo@example.com" })
      .returning();
    const client = await sessionClient(await signIn({ subject: "apple-jo", email: "JO@example.com", emailVerified: true }));
    expect(client.id).toBe(existing!.id);
  });

  it("gives a new account its own record when several clients share the email", async () => {
    const family = await db
      .insert(schema.clients)
      .values([
        { practiceId: clinicId, firstName: "Sam", lastName: "One", email: "family@example.com" },
        { practiceId: clinicId, firstName: "Alex", lastName: "Two", email: "family@example.com" },
      ])
      .returning({ id: schema.clients.id });
    const client = await sessionClient(
      await signIn({ subject: "apple-family", email: "family@example.com", emailVerified: true }, { givenName: "Max" }),
    );
    expect(family.map((row) => row.id)).not.toContain(client.id);
    expect(client).toMatchObject({ firstName: "Max", email: "family@example.com" });
    expect(await identitiesFor("apple-family")).toHaveLength(1);
  });

  it("joins the practice named in PORTAL_SIGNUP_PRACTICE_ID, or the first one, when the server has several", async () => {
    const [other] = await db
      .insert(schema.practices)
      .values({ name: "Another Practice" })
      .returning({ id: schema.practices.id });
    const identity = { subject: "apple-two-practices", email: "two@example.com", emailVerified: true };

    // Without the setting, the account still gets made, in the first practice set up.
    vi.stubEnv("PORTAL_SIGNUP_PRACTICE_ID", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fallback = await sessionClient(
      await signIn({ subject: "apple-unset-practice", email: "unset@example.com", emailVerified: true }),
    );
    expect(fallback.practiceId).toBe(clinicId);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("PORTAL_SIGNUP_PRACTICE_ID"));
    warn.mockRestore();

    vi.stubEnv("PORTAL_SIGNUP_PRACTICE_ID", other!.id);
    const client = await sessionClient(await signIn(identity));
    expect(client.practiceId).toBe(other!.id);
  });
});
