import { and, eq, isNull, sql } from "drizzle-orm";
import { users } from "@openpims/db";
import type { Database } from "@openpims/db/client";
import type { AppleIdentity } from "@/lib/portal/apple-sign-in";

/**
 * Sign in with Apple for staff, inside the clinic's staff iPhone/iPad app.
 *
 * Apple never creates a staff login: an Apple ID only opens a login that
 * already exists. It is connected either by the staff member turning it on
 * while signed in, or on first use when Apple shares a verified email (not a
 * Hide My Email address) that the server lists for that login in
 * APPLE_STAFF_APPLE_IDS ("apple@email=login@email"). An Apple ID whose email
 * merely equals a login's email is not enough on its own.
 */

export const STAFF_APPLE_NONCE_COOKIE = "openvpm_staff_apple_nonce";
/** Sent to the sign-in callback and the connect endpoint, nowhere else. */
export const STAFF_APPLE_NONCE_COOKIE_PATH = "/api/auth";

/** Bundle ids of staff apps whose Apple tokens open staff logins; empty = off. */
export function staffAppleClientIds(): string[] {
  return (process.env.APPLE_STAFF_SIGN_IN_CLIENT_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

export function staffAppleSignInEnabled(): boolean {
  return staffAppleClientIds().length > 0;
}

/**
 * Apple IDs the server lets open a staff login whose email differs, as
 * APPLE_STAFF_APPLE_IDS="me@icloud.com=me@clinic.com,...". Keys and values
 * are lower-cased emails.
 */
export function staffAppleIdAliases(): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const pair of (process.env.APPLE_STAFF_APPLE_IDS ?? "").split(",")) {
    const [apple, login] = pair.split("=").map((part) => part?.trim().toLowerCase());
    if (apple && login && apple.includes("@") && login.includes("@")) aliases.set(apple, login);
  }
  return aliases;
}

/** Reads one cookie from a raw Cookie header. */
export function cookieFromHeader(
  header: string | null | undefined,
  name: string,
): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    const value = part.slice(index + 1).trim();
    try {
      return decodeURIComponent(value) || null;
    } catch {
      return null;
    }
  }
  return null;
}

/** An email Apple vouches for and that reaches the person directly. */
export function appleEmailForMatching(identity: AppleIdentity): string | null {
  if (!identity.email || !identity.emailVerified || identity.privateRelayEmail) {
    return null;
  }
  return identity.email.trim().toLowerCase();
}

type StaffUser = typeof users.$inferSelect;

/**
 * The staff login this Apple ID opens, connecting it on first use when the
 * verified email matches. Returns null when no login matches.
 */
export async function findStaffForAppleIdentity(
  tx: Database,
  identity: AppleIdentity,
  now: Date = new Date(),
): Promise<StaffUser | null> {
  const [linked] = await tx
    .select()
    .from(users)
    .where(and(eq(users.appleSubject, identity.subject), isNull(users.deletedAt)))
    .limit(1);
  if (linked) return linked;

  // Only Apple IDs the server lists connect on first use; anyone else must
  // turn it on while signed in with their password.
  const appleEmail = appleEmailForMatching(identity);
  const email = appleEmail ? staffAppleIdAliases().get(appleEmail) : undefined;
  if (!email) return null;

  // Staff emails are stored lower-cased (sign-in compares them that way).
  const [byEmail] = await tx
    .select()
    .from(users)
    .where(
      and(
        eq(users.email, email),
        isNull(users.deletedAt),
        isNull(users.appleSubject),
      ),
    )
    .limit(1);
  if (!byEmail) return null;

  await releaseRetiredAppleSubject(tx, identity.subject);
  const [connected] = await tx
    .update(users)
    .set({ appleSubject: identity.subject, appleLinkedAt: now, updatedAt: now })
    .where(and(eq(users.id, byEmail.id), isNull(users.appleSubject)))
    .returning();
  return connected ?? null;
}

/**
 * A removed staff login keeps its row; free its Apple ID so the person can
 * connect it to their current login.
 */
export async function releaseRetiredAppleSubject(
  tx: Database,
  subject: string,
): Promise<void> {
  await tx
    .update(users)
    .set({ appleSubject: null, appleLinkedAt: null })
    .where(and(eq(users.appleSubject, subject), sql`${users.deletedAt} is not null`));
}

export type ConnectOutcome = "connected" | "already_connected" | "taken" | "signed_out";

/** Connects an Apple ID to the signed-in staff login. */
export async function connectAppleToStaff(
  tx: Database,
  userId: string,
  subject: string,
  now: Date = new Date(),
): Promise<ConnectOutcome> {
  const [me] = await tx
    .select({ id: users.id, appleSubject: users.appleSubject })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1);
  if (!me) return "signed_out";
  if (me.appleSubject === subject) return "already_connected";

  await releaseRetiredAppleSubject(tx, subject);
  const [other] = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.appleSubject, subject), isNull(users.deletedAt)))
    .limit(1);
  if (other && other.id !== userId) return "taken";

  await tx
    .update(users)
    .set({ appleSubject: subject, appleLinkedAt: now, updatedAt: now })
    .where(eq(users.id, userId));
  return "connected";
}

export async function disconnectAppleFromStaff(
  tx: Database,
  userId: string,
  now: Date = new Date(),
): Promise<void> {
  await tx
    .update(users)
    .set({ appleSubject: null, appleLinkedAt: null, updatedAt: now })
    .where(eq(users.id, userId));
}
