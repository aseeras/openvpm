"use client";

import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { ZP } from "@/lib/portal/zenpaws-theme";
import { nativeAppleSignInAvailable, runAppleSignIn } from "@/lib/portal/native-apple-sign-in";

function AppleLogo() {
  return (
    <svg viewBox="0 0 17 20" className="h-[18px] w-[18px]" fill="currentColor" aria-hidden="true">
      <path d="M14.2 10.6c0-2.6 2.1-3.8 2.2-3.9-1.2-1.8-3.1-2-3.7-2-1.6-.2-3.1.9-3.9.9-.8 0-2.1-.9-3.4-.9C3.6 4.7 2 5.7 1.1 7.3c-1.9 3.2-.5 8 1.3 10.6.9 1.3 1.9 2.7 3.3 2.7 1.3-.1 1.8-.9 3.4-.9 1.6 0 2 .9 3.4.8 1.4 0 2.3-1.3 3.2-2.6 1-1.5 1.4-2.9 1.4-3-.1 0-2.9-1.1-2.9-4.3ZM11.6 3c.7-.9 1.2-2.1 1.1-3.3-1 0-2.3.7-3 1.6-.7.8-1.3 2-1.1 3.2 1.1.1 2.3-.6 3-1.5Z" />
    </svg>
  );
}

/**
 * Apple's black "Sign in with Apple" button. It only appears inside the
 * iPhone app, and only when the server has Sign in with Apple turned on.
 */
export function AppleSignInButton({
  mode,
  onLinked,
}: {
  mode: "sign_in" | "link";
  onLinked?: () => void;
}) {
  const [native, setNative] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = trpc.portalSignIn.options.useQuery(undefined, { enabled: native, staleTime: 10 * 60 * 1000 });

  useEffect(() => setNative(nativeAppleSignInAvailable()), []);
  if (!native || !options.data?.apple) return null;

  async function start() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await runAppleSignIn(mode);
    if (result.status === "ok") {
      if (mode === "sign_in") {
        window.location.reload();
        return;
      }
      onLinked?.();
    } else if (result.status === "error") {
      setError(result.message);
    }
    setBusy(false);
  }

  return (
    <div>
      <button
        type="button"
        onClick={start}
        disabled={busy}
        className="flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-black text-[17px] font-semibold text-white disabled:opacity-60"
      >
        <AppleLogo />
        {busy ? "Signing in…" : mode === "link" ? "Turn on Sign in with Apple" : "Sign in with Apple"}
      </button>
      {error ? (
        <p role="alert" className="mt-2 rounded-xl p-3 text-left text-sm font-semibold" style={{ backgroundColor: ZP.dangerSoft, color: ZP.danger }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
