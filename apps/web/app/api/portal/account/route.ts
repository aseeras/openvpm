import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { compare, hash } from "bcryptjs";
import { z } from "zod";
import {
  clients,
  portalAccounts,
  portalEmailCodes,
  portalSessions,
  practices,
} from "@openpims/db";
import { db } from "@openpims/db/client";
import type { Database } from "@openpims/db/client";
import { withSystem } from "@/lib/tenant-db";
import { readJsonRequestBody } from "@/lib/request-json";
import { clientIpFromRequest } from "@/lib/request-ip";
import { isSameOriginRequest } from "@/lib/request-origin";
import { rateLimit } from "@/lib/rate-limit";
import { authPasswordInput, AUTH_PASSWORD_MAX_LENGTH } from "@/lib/auth-password";
import { PASSWORD_HASH_COST } from "@/lib/auth-hashing";
import { sendPortalEmailCode } from "@/lib/email";
import {
  emailCodeMatches,
  generateEmailCode,
  hashEmailCode,
  normalizeEmail,
  normalizeUsername,
  PORTAL_ACCOUNT_LOCK_MS,
  PORTAL_ACCOUNT_MAX_FAILED_SIGN_INS,
  PORTAL_DUMMY_PASSWORD_HASH,
  PORTAL_EMAIL_CODE_MAX_ATTEMPTS,
  PORTAL_EMAIL_CODE_TTL_MS,
  PORTAL_USERNAME_PATTERN,
  signUpPracticeId,
} from "@/lib/portal/accounts";
import { insertPortalSession } from "@/lib/portal/create-session";
import {
  portalSessionCookieName,
  portalSessionCookieOptions,
} from "@/lib/portal/session";

/**
 * Client portal accounts for pet owners: create an account (confirmed by a
 * code emailed to them), sign in with username or email and password, and
 * reset a forgotten password. Staff logins are separate and unaffected.
 */

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store, max-age=0" };
const email = z.string().trim().email("Enter a valid email address.").max(255);
const code = z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code.");
const name = z.string().trim().min(1, "Enter your name.").max(64);

const input = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("sign_up"),
    firstName: name,
    lastName: name,
    email,
    username: z
      .string()
      .transform(normalizeUsername)
      .refine((value) => PORTAL_USERNAME_PATTERN.test(value), {
        message: "Usernames are 3–32 letters, numbers, dots, dashes or underscores.",
      }),
    password: authPasswordInput,
  }),
  z.object({ action: z.literal("verify_sign_up"), codeId: z.string().guid(), code }),
  z.object({
    action: z.literal("sign_in"),
    login: z.string().trim().min(1).max(255),
    password: z.string().min(1).max(AUTH_PASSWORD_MAX_LENGTH),
  }),
  z.object({ action: z.literal("forgot"), email }),
  z.object({
    action: z.literal("reset"),
    codeId: z.string().guid(),
    code,
    password: authPasswordInput,
  }),
]);

type Failure = { error: string; status: number; field?: string };

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

function signedIn(rawSessionToken: string, now: Date) {
  const response = json({ redirectTo: "/portal" });
  response.cookies.set(portalSessionCookieName(), rawSessionToken, portalSessionCookieOptions(now));
  return response;
}

async function allowed(key: string, limit: number, windowMs: number): Promise<boolean> {
  try {
    return (await rateLimit({ key, limit, windowMs })).success;
  } catch {
    return false;
  }
}

function isUniqueViolation(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string }; code?: string }) ?? {};
  return cause.code === "23505" || cause.cause?.code === "23505";
}

async function usernameTaken(tx: Database, username: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: portalAccounts.id })
    .from(portalAccounts)
    .where(and(eq(portalAccounts.username, username), isNull(portalAccounts.deletedAt)))
    .limit(1);
  return Boolean(row);
}

async function practiceName(tx: Database, practiceId: string): Promise<string> {
  const [row] = await tx
    .select({ name: practices.name })
    .from(practices)
    .where(eq(practices.id, practiceId))
    .limit(1);
  return row?.name ?? "ZenPaws";
}

/** Check an emailed code, counting the attempt; returns the row on success. */
async function useEmailCode(
  tx: Database,
  codeId: string,
  submitted: string,
  purpose: "sign_up" | "reset",
  now: Date,
) {
  const [row] = await tx
    .select()
    .from(portalEmailCodes)
    .where(
      and(
        eq(portalEmailCodes.id, codeId),
        eq(portalEmailCodes.purpose, purpose),
        isNull(portalEmailCodes.consumedAt),
        isNull(portalEmailCodes.deletedAt),
      ),
    )
    .for("update")
    .limit(1);
  if (!row || row.expiresAt <= now || row.attempts >= PORTAL_EMAIL_CODE_MAX_ATTEMPTS) {
    return { failure: { error: "That code has expired. Please start again.", status: 410 } as Failure };
  }
  if (!emailCodeMatches(row.id, submitted, row.codeHash)) {
    await tx
      .update(portalEmailCodes)
      .set({ attempts: row.attempts + 1 })
      .where(eq(portalEmailCodes.id, row.id));
    return { failure: { error: "That code isn't right. Check the email and try again.", status: 400, field: "code" } as Failure };
  }
  await tx.update(portalEmailCodes).set({ consumedAt: now }).where(eq(portalEmailCodes.id, row.id));
  return { row };
}

async function createEmailCode(
  tx: Database,
  values: { practiceId: string; purpose: "sign_up" | "reset"; email: string; payload: Record<string, unknown> },
  now: Date,
) {
  const id = randomUUID();
  const emailCode = generateEmailCode();
  await tx.insert(portalEmailCodes).values({
    id,
    ...values,
    codeHash: hashEmailCode(id, emailCode),
    expiresAt: new Date(now.getTime() + PORTAL_EMAIL_CODE_TTL_MS),
  });
  return { id, code: emailCode };
}

export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) return json({ error: "Invalid request origin" }, 403);
  const body = await readJsonRequestBody(req);
  const parsed = body.ok ? input.safeParse(body.data) : null;
  if (!parsed?.success) {
    const issue = parsed?.error.issues[0];
    return json(
      { error: issue?.message ?? "Please check the form and try again.", field: issue?.path[0] },
      400,
    );
  }
  const data = parsed.data;
  const ip = clientIpFromRequest(req);
  const now = new Date();
  const userAgent = req.headers.get("user-agent");

  if (!(await allowed(`portal-account:${data.action}:ip:${ip}`, 20, 15 * 60 * 1000))) {
    return json({ error: "Too many tries. Please wait a few minutes." }, 429);
  }

  try {
    switch (data.action) {
      case "sign_up": {
        const address = normalizeEmail(data.email);
        if (!(await allowed(`portal-account:code:${address}`, 3, 60 * 60 * 1000))) {
          return json({ error: "We've sent several codes to this email. Please wait a bit." }, 429);
        }
        const passwordHash = await hash(data.password, PASSWORD_HASH_COST);
        const result = await withSystem(db, async (tx) => {
          const practiceId = await signUpPracticeId(tx);
          if (!practiceId) {
            return { failure: { error: "Creating accounts isn't available right now.", status: 503 } as Failure };
          }
          if (await usernameTaken(tx, data.username)) {
            return { failure: { error: "That username is taken. Try another.", status: 409, field: "username" } as Failure };
          }
          const created = await createEmailCode(
            tx,
            {
              practiceId,
              purpose: "sign_up",
              email: address,
              payload: { firstName: data.firstName, lastName: data.lastName, username: data.username, passwordHash },
            },
            now,
          );
          return { created, practice: await practiceName(tx, practiceId) };
        });
        if ("failure" in result && result.failure) return json(result.failure, result.failure.status);
        const sent = await sendPortalEmailCode({
          to: address,
          practiceName: result.practice,
          code: result.created.code,
          purpose: "sign_up",
        });
        if (!sent.success) return json({ error: "We couldn't send the email. Please try again." }, 502);
        return json({ codeId: result.created.id, email: address });
      }

      case "verify_sign_up": {
        const result = await withSystem(db, async (tx) => {
          const used = await useEmailCode(tx, data.codeId, data.code, "sign_up", now);
          if (used.failure) return used;
          const { row } = used;
          const payload = row.payload as { firstName: string; lastName: string; username: string; passwordHash: string };
          if (await usernameTaken(tx, payload.username)) {
            return { failure: { error: "That username was just taken. Please start again with another.", status: 409 } as Failure };
          }
          // An existing client with this (now confirmed) email gets the
          // account; otherwise the person becomes a new client.
          const matches = await tx
            .select({ id: clients.id, hasAccount: sql<boolean>`${portalAccounts.id} is not null` })
            .from(clients)
            .leftJoin(
              portalAccounts,
              and(
                eq(portalAccounts.clientId, clients.id),
                eq(portalAccounts.practiceId, clients.practiceId),
                isNull(portalAccounts.deletedAt),
              ),
            )
            .where(
              and(
                eq(clients.practiceId, row.practiceId),
                sql`lower(${clients.email}) = ${row.email}`,
                isNull(clients.deletedAt),
              ),
            )
            .orderBy(asc(clients.createdAt));
          let clientId = matches.find((match) => !match.hasAccount)?.id;
          if (!clientId && matches.length > 0) {
            return {
              failure: {
                error: "This email already has an account. Sign in, or reset your password.",
                status: 409,
              } as Failure,
            };
          }
          if (!clientId) {
            const [client] = await tx
              .insert(clients)
              .values({
                practiceId: row.practiceId,
                firstName: payload.firstName,
                lastName: payload.lastName,
                email: row.email,
              })
              .returning({ id: clients.id });
            clientId = client!.id;
          }
          await tx.insert(portalAccounts).values({
            practiceId: row.practiceId,
            clientId,
            username: payload.username,
            passwordHash: payload.passwordHash,
            lastSignInAt: now,
          });
          // The pending password hash is no longer needed.
          await tx.update(portalEmailCodes).set({ payload: {} }).where(eq(portalEmailCodes.id, row.id));
          const token = await insertPortalSession(tx, { practiceId: row.practiceId, clientId, ip, userAgent, now });
          return { token };
        });
        if ("failure" in result && result.failure) return json(result.failure, result.failure.status);
        return signedIn((result as { token: string }).token, now);
      }

      case "sign_in": {
        const login = data.login.trim().toLowerCase();
        const result = await withSystem(db, async (tx) => {
          const [account] = await tx
            .select({
              id: portalAccounts.id,
              practiceId: portalAccounts.practiceId,
              clientId: portalAccounts.clientId,
              passwordHash: portalAccounts.passwordHash,
              failedAttempts: portalAccounts.failedAttempts,
              lockedUntil: portalAccounts.lockedUntil,
            })
            .from(portalAccounts)
            .innerJoin(
              clients,
              and(
                eq(clients.id, portalAccounts.clientId),
                eq(clients.practiceId, portalAccounts.practiceId),
                isNull(clients.deletedAt),
              ),
            )
            .innerJoin(practices, and(eq(practices.id, portalAccounts.practiceId), isNull(practices.deletedAt)))
            .where(
              and(
                isNull(portalAccounts.deletedAt),
                login.includes("@")
                  ? sql`lower(${clients.email}) = ${login}`
                  : eq(portalAccounts.username, login),
              ),
            )
            .orderBy(desc(portalAccounts.lastSignInAt))
            .limit(1);

          if (!account) {
            await compare(data.password, PORTAL_DUMMY_PASSWORD_HASH);
            return { failure: { error: "Wrong username or password.", status: 401 } as Failure };
          }
          if (account.lockedUntil && account.lockedUntil > now) {
            return {
              failure: {
                error: "Too many wrong passwords. Try again in 15 minutes, or reset your password.",
                status: 423,
              } as Failure,
            };
          }
          if (!(await compare(data.password, account.passwordHash))) {
            const failures = account.failedAttempts + 1;
            const lock = failures >= PORTAL_ACCOUNT_MAX_FAILED_SIGN_INS;
            await tx
              .update(portalAccounts)
              .set({
                failedAttempts: lock ? 0 : failures,
                lockedUntil: lock ? new Date(now.getTime() + PORTAL_ACCOUNT_LOCK_MS) : account.lockedUntil,
              })
              .where(eq(portalAccounts.id, account.id));
            return { failure: { error: "Wrong username or password.", status: 401 } as Failure };
          }
          await tx
            .update(portalAccounts)
            .set({ failedAttempts: 0, lockedUntil: null, lastSignInAt: now })
            .where(eq(portalAccounts.id, account.id));
          const token = await insertPortalSession(tx, {
            practiceId: account.practiceId,
            clientId: account.clientId,
            ip,
            userAgent,
            now,
          });
          return { token };
        });
        if ("failure" in result && result.failure) return json(result.failure, result.failure.status);
        return signedIn((result as { token: string }).token, now);
      }

      case "forgot": {
        const address = normalizeEmail(data.email);
        if (!(await allowed(`portal-account:code:${address}`, 3, 60 * 60 * 1000))) {
          return json({ error: "We've sent several codes to this email. Please wait a bit." }, 429);
        }
        const result = await withSystem(db, async (tx) => {
          const [account] = await tx
            .select({ id: portalAccounts.id, practiceId: portalAccounts.practiceId })
            .from(portalAccounts)
            .innerJoin(
              clients,
              and(
                eq(clients.id, portalAccounts.clientId),
                eq(clients.practiceId, portalAccounts.practiceId),
                isNull(clients.deletedAt),
              ),
            )
            .where(and(isNull(portalAccounts.deletedAt), sql`lower(${clients.email}) = ${address}`))
            .orderBy(desc(portalAccounts.lastSignInAt))
            .limit(1);
          if (!account) return null;
          const created = await createEmailCode(
            tx,
            { practiceId: account.practiceId, purpose: "reset", email: address, payload: { accountId: account.id } },
            now,
          );
          return { created, practice: await practiceName(tx, account.practiceId) };
        });
        // Same answer whether or not the email has an account.
        if (!result) return json({ codeId: randomUUID(), email: address });
        await sendPortalEmailCode({
          to: address,
          practiceName: result.practice,
          code: result.created.code,
          purpose: "reset",
        });
        return json({ codeId: result.created.id, email: address });
      }

      case "reset": {
        const passwordHash = await hash(data.password, PASSWORD_HASH_COST);
        const result = await withSystem(db, async (tx) => {
          const used = await useEmailCode(tx, data.codeId, data.code, "reset", now);
          if (used.failure) return used;
          const accountId = (used.row.payload as { accountId?: string }).accountId ?? "";
          const [account] = await tx
            .update(portalAccounts)
            .set({ passwordHash, failedAttempts: 0, lockedUntil: null, lastSignInAt: now })
            .where(and(eq(portalAccounts.id, accountId), isNull(portalAccounts.deletedAt)))
            .returning({ practiceId: portalAccounts.practiceId, clientId: portalAccounts.clientId });
          if (!account) {
            return { failure: { error: "That code has expired. Please start again.", status: 410 } as Failure };
          }
          // Sign out everywhere else after a password change.
          await tx
            .update(portalSessions)
            .set({ revokedAt: now, revokedReason: "password_reset" })
            .where(
              and(
                eq(portalSessions.practiceId, account.practiceId),
                eq(portalSessions.clientId, account.clientId),
                isNull(portalSessions.revokedAt),
                gt(portalSessions.expiresAt, now),
              ),
            );
          const token = await insertPortalSession(tx, { ...account, ip, userAgent, now });
          return { token };
        });
        if ("failure" in result && result.failure) return json(result.failure, result.failure.status);
        return signedIn((result as { token: string }).token, now);
      }
    }
  } catch (error) {
    if (isUniqueViolation(error)) {
      return json({ error: "That username was just taken. Please choose another.", field: "username" }, 409);
    }
    console.error(`[portal-account] ${data.action} failed`);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
}
