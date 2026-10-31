/**
 * Browser side of Sign in with Apple for staff. Only the staff iPhone/iPad
 * app can do it: its native plugin shows Apple's sheet and returns an
 * identity token, which the server checks before opening the staff login.
 */
import { signIn } from "next-auth/react";
import { nativeAppleAuthorize } from "@/lib/portal/native-apple-sign-in";

export { nativeAppleSignInAvailable } from "@/lib/portal/native-apple-sign-in";

export type StaffAppleResult =
  | { status: "ok" }
  | { status: "cancelled" }
  | { status: "error"; message: string };

const NOT_CONNECTED =
  "This Apple ID isn't connected to a staff login yet. Sign in with your email and password, then tap \"Turn on Sign in with Apple\" in the menu.";

const SIGN_IN_ERRORS: Record<string, string> = {
  apple_not_connected: NOT_CONNECTED,
  apple_expired: "Sign in with Apple timed out. Please try again.",
  apple_busy: "Too many attempts. Please wait a few minutes.",
};

export function staffAppleErrorMessage(code: string | null | undefined): string {
  return (code && SIGN_IN_ERRORS[code]) || "Sign in with Apple failed. Please try again.";
}

async function fetchNonce(): Promise<string | null> {
  const response = await fetch("/api/auth/apple-nonce", { method: "POST" });
  const data = (await response.json().catch(() => ({}))) as { nonce?: unknown };
  return response.ok && typeof data.nonce === "string" ? data.nonce : null;
}

export async function staffAppleAvailability(): Promise<{
  available: boolean;
  connected: boolean | null;
}> {
  try {
    const response = await fetch("/api/auth/apple-connection", { cache: "no-store" });
    const data = (await response.json()) as { available?: unknown; connected?: unknown };
    return {
      available: data.available === true,
      connected: typeof data.connected === "boolean" ? data.connected : null,
    };
  } catch {
    return { available: false, connected: null };
  }
}

async function appleToken(): Promise<
  { status: "ok"; identityToken: string } | Exclude<StaffAppleResult, { status: "ok" }>
> {
  const nonce = await fetchNonce();
  if (!nonce) return { status: "error", message: "Sign in with Apple isn't available right now." };
  const authorized = await nativeAppleAuthorize(nonce);
  if (authorized.status !== "ok") return authorized;
  return { status: "ok", identityToken: authorized.identityToken };
}

/** Signs a staff member in with Apple; they must already have a staff login. */
export async function runStaffAppleSignIn(): Promise<StaffAppleResult> {
  const token = await appleToken();
  if (token.status !== "ok") return token;
  const result = await signIn("apple", { identityToken: token.identityToken, redirect: false });
  if (!result || result.error) return { status: "error", message: staffAppleErrorMessage(result?.error) };
  return { status: "ok" };
}

/** Connects an Apple ID to the staff login that is signed in now. */
export async function connectStaffApple(): Promise<StaffAppleResult> {
  const token = await appleToken();
  if (token.status !== "ok") return token;
  const response = await fetch("/api/auth/apple-connection", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identityToken: token.identityToken }),
  });
  if (response.ok) return { status: "ok" };
  const data = (await response.json().catch(() => ({}))) as { error?: unknown };
  return {
    status: "error",
    message: typeof data.error === "string" ? data.error : "Sign in with Apple failed. Please try again.",
  };
}

export async function disconnectStaffApple(): Promise<boolean> {
  const response = await fetch("/api/auth/apple-connection", { method: "DELETE" });
  return response.ok;
}
