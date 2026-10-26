/**
 * Browser side of Sign in with Apple. Only the ZenPaws iPhone app can do it:
 * the app's native plugin shows Apple's sheet and returns an identity token,
 * which /api/portal/apple checks before signing the client in.
 */

const PLUGIN = "ZenPawsAppleSignIn";

type CapacitorBridge = {
  isNativePlatform?: () => boolean;
  isPluginAvailable?: (name: string) => boolean;
  nativePromise?: (plugin: string, method: string, options?: unknown) => Promise<unknown>;
};

function capacitor(): CapacitorBridge | null {
  if (typeof window === "undefined") return null;
  return ((window as unknown as { Capacitor?: CapacitorBridge }).Capacitor) ?? null;
}

export function nativeAppleSignInAvailable(): boolean {
  const cap = capacitor();
  return Boolean(
    cap?.isNativePlatform?.() && cap.isPluginAvailable?.(PLUGIN) && cap.nativePromise,
  );
}

export type AppleSignInResult =
  | { status: "ok" }
  | { status: "cancelled" }
  | { status: "error"; message: string; notLinked?: boolean };

async function postJson(url: string, body?: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: response.ok, data };
}

export async function runAppleSignIn(mode: "sign_in" | "link"): Promise<AppleSignInResult> {
  const cap = capacitor();
  if (!cap?.nativePromise || !nativeAppleSignInAvailable()) {
    return { status: "error", message: "Sign in with Apple works in the ZenPaws iPhone app." };
  }
  const nonceResponse = await postJson("/api/portal/apple/nonce");
  const nonce = nonceResponse.data.nonce;
  if (!nonceResponse.ok || typeof nonce !== "string") {
    return { status: "error", message: "Sign in with Apple isn't available right now." };
  }

  let identityToken: unknown;
  try {
    const result = (await cap.nativePromise(PLUGIN, "authorize", { nonce })) as {
      identityToken?: unknown;
    };
    identityToken = result?.identityToken;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Closing Apple's sheet is not an error worth showing.
    if (/cancel|1001/i.test(message)) return { status: "cancelled" };
    return { status: "error", message: "Sign in with Apple didn't finish. Please try again." };
  }
  if (typeof identityToken !== "string") {
    return { status: "error", message: "Sign in with Apple didn't finish. Please try again." };
  }

  const verified = await postJson("/api/portal/apple", { identityToken, mode });
  if (verified.ok) return { status: "ok" };
  return {
    status: "error",
    message: typeof verified.data.error === "string" ? verified.data.error : "Sign in with Apple failed.",
    notLinked: verified.data.code === "not_linked",
  };
}
