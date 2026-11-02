import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { appBaseUrl } from "@/lib/app-url";

/**
 * Check-in links are bearer capabilities scoped to one appointment:
 *   /check-in/<appointmentId>/<token>
 * The token is an HMAC of the appointment id under the server secret, so the
 * same link can be rebuilt anywhere (reminders, portal, staff "copy link")
 * without storing it. It lets the holder see the pet's name and visit time
 * and fill out that visit's form, and stops working once the visit ends or
 * is cancelled.
 */

export const CHECK_IN_TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How long after the visit starts the form still accepts answers. */
export const CHECK_IN_OPEN_AFTER_START_MS = 2 * 60 * 60 * 1000;

function checkInSecret(): string {
  const configured =
    process.env.CHECK_IN_LINK_SECRET?.trim() ||
    process.env.PORTAL_SESSION_SECRET?.trim() ||
    process.env.NEXTAUTH_SECRET?.trim();
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "CHECK_IN_LINK_SECRET, PORTAL_SESSION_SECRET or NEXTAUTH_SECRET is required in production",
    );
  }
  return "openvpm-local-check-in-link-secret";
}

export function checkInToken(appointmentId: string): string {
  return createHmac("sha256", checkInSecret())
    .update("openvpm:check-in:v1:")
    .update(appointmentId.toLowerCase())
    .digest("hex");
}

export function isCheckInLinkShape(
  appointmentId: string,
  token: string,
): boolean {
  return UUID_PATTERN.test(appointmentId) && CHECK_IN_TOKEN_PATTERN.test(token);
}

export function verifyCheckInToken(
  appointmentId: string,
  token: string,
): boolean {
  if (!isCheckInLinkShape(appointmentId, token)) return false;
  const expected = Buffer.from(checkInToken(appointmentId), "hex");
  const given = Buffer.from(token, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function checkInPath(appointmentId: string): string {
  return `/check-in/${appointmentId}/${checkInToken(appointmentId)}`;
}

export function checkInUrl(appointmentId: string): string {
  return `${appBaseUrl()}${checkInPath(appointmentId)}`;
}

/** Rate-limit key that never stores the raw capability. */
export function checkInRateLimitKey(prefix: string, token: string): string {
  return `${prefix}:token:${createHash("sha256").update(token).digest("hex")}`;
}

/** Whether the form for a visit in this state still takes answers. */
export function checkInIsOpen(
  appointment: { status: string; startTime: Date; deletedAt?: Date | null },
  now: Date = new Date(),
): boolean {
  if (appointment.deletedAt) return false;
  if (["cancelled", "no_show", "checked_out"].includes(appointment.status)) {
    return false;
  }
  return (
    now.getTime() <
    appointment.startTime.getTime() + CHECK_IN_OPEN_AFTER_START_MS
  );
}
