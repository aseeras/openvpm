import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import { practices } from "@openpims/db";
import type { Database } from "@openpims/db/client";

/**
 * Client portal accounts (username + password). These sign a pet owner into
 * the client portal only; they are separate from staff logins.
 */

export const PORTAL_USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/;
export const PORTAL_EMAIL_CODE_TTL_MS = 15 * 60 * 1000;
export const PORTAL_EMAIL_CODE_MAX_ATTEMPTS = 5;
export const PORTAL_ACCOUNT_MAX_FAILED_SIGN_INS = 10;
export const PORTAL_ACCOUNT_LOCK_MS = 15 * 60 * 1000;

// A real bcrypt hash of a random string, compared against when the username
// doesn't exist so a miss takes as long as a wrong password.
export const PORTAL_DUMMY_PASSWORD_HASH =
  "$2a$12$34eI2anYiGiD5grQCdkmfee0tUWWb2xTANlzCSKyg34ZxLK/3srT6";

export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function generateEmailCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function hashEmailCode(codeId: string, code: string): string {
  return createHash("sha256").update(`${codeId}:${code}`).digest("hex");
}

export function emailCodeMatches(codeId: string, code: string, storedHash: string): boolean {
  const candidate = Buffer.from(hashEmailCode(codeId, code), "hex");
  const stored = Buffer.from(storedHash, "hex");
  return candidate.length === stored.length && timingSafeEqual(candidate, stored);
}

/**
 * The practice new client accounts join: PORTAL_SIGNUP_PRACTICE_ID when set,
 * otherwise the server's only practice. Null (sign-up off) when ambiguous.
 */
export async function signUpPracticeId(tx: Database): Promise<string | null> {
  const configured = process.env.PORTAL_SIGNUP_PRACTICE_ID?.trim();
  const live = await tx
    .select({ id: practices.id })
    .from(practices)
    .where(
      configured
        ? and(isNull(practices.deletedAt), eq(practices.id, configured))
        : isNull(practices.deletedAt),
    )
    .orderBy(asc(practices.createdAt))
    .limit(2);
  if (configured) return live.length === 1 ? configured : null;
  return live.length === 1 ? live[0]!.id : null;
}
