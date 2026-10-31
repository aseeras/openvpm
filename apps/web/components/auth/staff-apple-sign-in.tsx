"use client";

import { useEffect, useState } from "react";
import {
  connectStaffApple,
  disconnectStaffApple,
  nativeAppleSignInAvailable,
  runStaffAppleSignIn,
  staffAppleAvailability,
} from "@/lib/staff-native-apple-sign-in";

function AppleLogo({ className = "h-[18px] w-[18px]" }: { className?: string }) {
  return (
    <svg viewBox="0 0 17 20" className={className} fill="currentColor" aria-hidden="true">
      <path d="M14.2 10.6c0-2.6 2.1-3.8 2.2-3.9-1.2-1.8-3.1-2-3.7-2-1.6-.2-3.1.9-3.9.9-.8 0-2.1-.9-3.4-.9C3.6 4.7 2 5.7 1.1 7.3c-1.9 3.2-.5 8 1.3 10.6.9 1.3 1.9 2.7 3.3 2.7 1.3-.1 1.8-.9 3.4-.9 1.6 0 2 .9 3.4.8 1.4 0 2.3-1.3 3.2-2.6 1-1.5 1.4-2.9 1.4-3-.1 0-2.9-1.1-2.9-4.3ZM11.6 3c.7-.9 1.2-2.1 1.1-3.3-1 0-2.3.7-3 1.6-.7.8-1.3 2-1.1 3.2 1.1.1 2.3-.6 3-1.5Z" />
    </svg>
  );
}

/** True only inside the staff app, once the server says Apple sign-in is on. */
function useStaffApple() {
  const [state, setState] = useState<{ available: boolean; connected: boolean | null }>({
    available: false,
    connected: null,
  });
  useEffect(() => {
    if (!nativeAppleSignInAvailable()) return;
    let active = true;
    staffAppleAvailability().then((next) => {
      if (active) setState(next);
    });
    return () => {
      active = false;
    };
  }, []);
  return [state, setState] as const;
}

/**
 * Apple's black "Sign in with Apple" button for the staff sign-in page. It
 * only appears inside the staff iPhone/iPad app.
 */
export function StaffAppleSignInButton({ onSignedIn }: { onSignedIn: () => void }) {
  const [{ available }] = useStaffApple();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!available) return null;

  async function start() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await runStaffAppleSignIn();
    if (result.status === "ok") {
      onSignedIn();
      return;
    }
    if (result.status === "error") setError(result.message);
    setBusy(false);
  }

  return (
    <div className="mt-4">
      <div className="mb-4 flex items-center gap-3 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        or
        <span className="h-px flex-1 bg-border" />
      </div>
      <button
        type="button"
        onClick={start}
        disabled={busy}
        className="flex min-h-11 w-full items-center justify-center gap-2 rounded-md bg-black px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
      >
        <AppleLogo />
        {busy ? "Signing in..." : "Sign in with Apple"}
      </button>
      {error ? (
        <p role="alert" className="mt-2 rounded-md border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Lets a signed-in staff member connect (or disconnect) their Apple ID, so
 * next time they can sign in with Face ID instead of a password. Only shown
 * inside the staff app.
 */
export function StaffAppleConnect() {
  const [state, setState] = useStaffApple();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  if (!state.available || state.connected === null) return null;

  async function connect() {
    setBusy(true);
    setMessage(null);
    const result = await connectStaffApple();
    if (result.status === "ok") {
      setState({ available: true, connected: true });
      setMessage("Sign in with Apple is on. Use it next time you sign in.");
    } else if (result.status === "error") {
      setMessage(result.message);
    }
    setBusy(false);
  }

  async function disconnect() {
    setBusy(true);
    setMessage(null);
    if (await disconnectStaffApple()) setState({ available: true, connected: false });
    else setMessage("Couldn't turn off Sign in with Apple. Please try again.");
    setBusy(false);
  }

  return (
    <div className="mb-2 px-3">
      {state.connected ? (
        <button
          type="button"
          onClick={disconnect}
          disabled={busy}
          className="flex w-full items-center gap-2 rounded-md py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-60"
        >
          <AppleLogo className="h-3.5 w-3.5" />
          Sign in with Apple is on · Turn off
        </button>
      ) : (
        <button
          type="button"
          onClick={connect}
          disabled={busy}
          className="flex min-h-9 w-full items-center justify-center gap-2 rounded-md bg-black px-3 text-xs font-semibold text-white disabled:opacity-60"
        >
          <AppleLogo className="h-3.5 w-3.5" />
          {busy ? "Connecting..." : "Turn on Sign in with Apple"}
        </button>
      )}
      {message ? (
        <p role="status" className="mt-1 text-xs text-muted-foreground">
          {message}
        </p>
      ) : null}
    </div>
  );
}
