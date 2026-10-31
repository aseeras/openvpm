import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "../../../../packages/db/schema/index";
import type { Database } from "@openpims/db/client";
import {
  connectAppleToStaff,
  disconnectAppleFromStaff,
  findStaffForAppleIdentity,
} from "../staff-apple-sign-in";

/**
 * Staff Sign in with Apple against a real, freshly migrated database: an
 * Apple ID only ever opens a staff login that already exists.
 */

const repoRoot = resolve(process.cwd(), "../..");
const describeWithPostgres = process.env.STAFF_APPLE_DB_INTEGRATION === "1" ? describe : describe.skip;

describeWithPostgres("staff Sign in with Apple (PostgreSQL)", () => {
  const databaseName = `openpims_staff_apple_${randomUUID().replaceAll("-", "")}`;
  let adminSql: ReturnType<typeof postgres>;
  let ownerSql: ReturnType<typeof postgres>;
  let db: Database;
  let clinicId: string;
  const now = new Date("2026-10-31T12:00:00Z");
  const apple = (subject: string, email: string | null, extra: Partial<{ emailVerified: boolean; privateRelayEmail: boolean }> = {}) => ({
    subject,
    email,
    emailVerified: email !== null,
    privateRelayEmail: false,
    ...extra,
  });

  async function staff(email: string) {
    const [user] = await db
      .insert(schema.users)
      .values({ practiceId: clinicId, email, name: email, passwordHash: "x", role: "admin" })
      .returning();
    return user!;
  }

  beforeAll(async () => {
    const adminUrl = process.env.DATABASE_URL;
    if (!adminUrl) throw new Error("DATABASE_URL is required");
    if (!/^openpims_staff_apple_[a-f0-9]+$/.test(databaseName)) throw new Error("unsafe disposable database name");
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
      .values({ name: "Synthetic Staff Clinic" })
      .returning({ id: schema.practices.id });
    clinicId = clinic!.id;
  }, 90_000);

  afterAll(async () => {
    await ownerSql?.end();
    if (adminSql) {
      await adminSql.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await adminSql.end();
    }
  });

  it("never creates a staff login for an unknown Apple ID", async () => {
    const before = await db.select({ id: schema.users.id }).from(schema.users);
    expect(await findStaffForAppleIdentity(db, apple("unknown", "stranger@example.com"), now)).toBeNull();
    expect(await findStaffForAppleIdentity(db, apple("unknown-2", null), now)).toBeNull();
    expect(await db.select({ id: schema.users.id }).from(schema.users)).toHaveLength(before.length);
  });

  it("doesn't connect on a matching email alone; only Apple IDs the server lists", async () => {
    const vet = await staff("vet@clinic.example");
    expect(await findStaffForAppleIdentity(db, apple("apple-vet", "vet@clinic.example"), now)).toBeNull();

    vi.stubEnv("APPLE_STAFF_APPLE_IDS", "Vet@Clinic.example=vet@clinic.example");
    try {
      const found = await findStaffForAppleIdentity(db, apple("apple-vet", "Vet@Clinic.example"), now);
      expect(found?.id).toBe(vet.id);
      expect(found?.appleSubject).toBe("apple-vet");
    } finally {
      vi.unstubAllEnvs();
    }
    // Later sign-ins may come with Hide My Email or no email at all.
    expect((await findStaffForAppleIdentity(db, apple("apple-vet", null), now))?.id).toBe(vet.id);
  });

  it("doesn't match on an unverified or Hide My Email address", async () => {
    await staff("tech@clinic.example");
    vi.stubEnv("APPLE_STAFF_APPLE_IDS", "tech@clinic.example=tech@clinic.example");
    try {
      expect(
        await findStaffForAppleIdentity(db, apple("apple-tech", "tech@clinic.example", { emailVerified: false }), now),
      ).toBeNull();
      expect(
        await findStaffForAppleIdentity(db, apple("apple-tech", "tech@clinic.example", { privateRelayEmail: true }), now),
      ).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("doesn't let a second Apple ID take over a login that already has one", async () => {
    const owner = await staff("owner@clinic.example");
    await connectAppleToStaff(db, owner.id, "apple-owner", now);
    vi.stubEnv("APPLE_STAFF_APPLE_IDS", "owner@clinic.example=owner@clinic.example");
    expect(await findStaffForAppleIdentity(db, apple("apple-intruder", "owner@clinic.example"), now)).toBeNull();
    vi.unstubAllEnvs();
    expect((await findStaffForAppleIdentity(db, apple("apple-owner", null), now))?.id).toBe(owner.id);
  });

  it("connects an Apple ID to the signed-in login, refuses one used by someone else, and disconnects", async () => {
    const front = await staff("front@clinic.example");
    const manager = await staff("manager@clinic.example");
    expect(await connectAppleToStaff(db, front.id, "apple-personal", now)).toBe("connected");
    expect(await connectAppleToStaff(db, front.id, "apple-personal", now)).toBe("already_connected");
    expect(await connectAppleToStaff(db, manager.id, "apple-personal", now)).toBe("taken");
    expect((await findStaffForAppleIdentity(db, apple("apple-personal", "someone@icloud.com"), now))?.id).toBe(front.id);

    await disconnectAppleFromStaff(db, front.id, now);
    expect(await findStaffForAppleIdentity(db, apple("apple-personal", null), now)).toBeNull();
    expect(await connectAppleToStaff(db, manager.id, "apple-personal", now)).toBe("connected");
  });

  it("lets an Apple ID the server names open a login with a different email", async () => {
    const admin = await staff("admin@clinic.example");
    vi.stubEnv("APPLE_STAFF_APPLE_IDS", "Owner.Personal@iCloud.example=Admin@Clinic.example, bad-entry");
    try {
      expect(
        await findStaffForAppleIdentity(db, apple("apple-stranger", "stranger@icloud.example"), now),
      ).toBeNull();
      expect(
        await findStaffForAppleIdentity(
          db,
          apple("apple-alias", "owner.personal@icloud.example", { privateRelayEmail: true }),
          now,
        ),
      ).toBeNull();
      const found = await findStaffForAppleIdentity(db, apple("apple-alias", "owner.personal@icloud.example"), now);
      expect(found?.id).toBe(admin.id);
    } finally {
      vi.unstubAllEnvs();
    }
    // Once connected it keeps working without the server setting.
    expect((await findStaffForAppleIdentity(db, apple("apple-alias", null), now))?.id).toBe(admin.id);
  });

  it("frees the Apple ID of a removed staff login", async () => {
    const leaver = await staff("leaver@clinic.example");
    await connectAppleToStaff(db, leaver.id, "apple-leaver", now);
    await db.update(schema.users).set({ deletedAt: now }).where(eq(schema.users.id, leaver.id));
    expect(await findStaffForAppleIdentity(db, apple("apple-leaver", null), now)).toBeNull();

    const returning = await staff("returning@clinic.example");
    expect(await connectAppleToStaff(db, returning.id, "apple-leaver", now)).toBe("connected");
    expect((await findStaffForAppleIdentity(db, apple("apple-leaver", null), now))?.id).toBe(returning.id);
  });
});
