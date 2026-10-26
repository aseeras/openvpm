"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { ZP } from "@/lib/portal/zenpaws-theme";
import { AppleSignInButton } from "@/components/portal/apple-sign-in-button";

type Mode = "sign_in" | "sign_up" | "verify" | "forgot" | "reset";
type Result = { ok: boolean; data: Record<string, unknown> };

async function call(body: Record<string, unknown>): Promise<Result> {
  try {
    const response = await fetch("/api/portal/account", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: response.ok, data };
  } catch {
    return { ok: false, data: { error: "You seem to be offline. Please try again." } };
  }
}

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="block text-left">
      <span className="mb-1 block text-[13px] font-extrabold">{label}</span>
      {children}
    </label>
  );
}

const inputClass =
  "block min-h-12 w-full rounded-2xl border bg-white px-4 text-base font-semibold outline-none focus:ring-2";

function TextLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="text-sm font-extrabold" style={{ color: ZP.accent }}>
      {children}
    </button>
  );
}

/**
 * Sign in, create an account, and reset a password for the client portal
 * (pet owners). Successful sign-in reloads the page so it opens signed in.
 */
export function PortalAuth({ initialMode = "sign_in" }: { initialMode?: Mode }) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [codeId, setCodeId] = useState("");
  const [sentTo, setSentTo] = useState("");
  const [form, setForm] = useState({
    login: "",
    password: "",
    firstName: "",
    lastName: "",
    email: "",
    username: "",
    code: "",
  });

  const set = (key: keyof typeof form) => (event: { target: { value: string } }) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));
  const go = (next: Mode) => {
    setError(null);
    setForm((current) => ({ ...current, password: "", code: "" }));
    setMode(next);
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    let result: Result;
    if (mode === "sign_in") {
      result = await call({ action: "sign_in", login: form.login, password: form.password });
    } else if (mode === "sign_up") {
      result = await call({
        action: "sign_up",
        firstName: form.firstName,
        lastName: form.lastName,
        email: form.email,
        username: form.username,
        password: form.password,
      });
    } else if (mode === "verify") {
      result = await call({ action: "verify_sign_up", codeId, code: form.code });
    } else if (mode === "forgot") {
      result = await call({ action: "forgot", email: form.email });
    } else {
      result = await call({ action: "reset", codeId, code: form.code, password: form.password });
    }

    if (!result.ok) {
      setError(typeof result.data.error === "string" ? result.data.error : "Something went wrong. Please try again.");
      setBusy(false);
      return;
    }
    if (result.data.redirectTo) {
      window.location.reload();
      return;
    }
    if (typeof result.data.codeId === "string") {
      setCodeId(result.data.codeId);
      setSentTo(typeof result.data.email === "string" ? result.data.email : form.email);
      setForm((current) => ({ ...current, code: "", password: mode === "forgot" ? "" : current.password }));
      setMode(mode === "forgot" ? "reset" : "verify");
    }
    setBusy(false);
  }

  const style = { borderColor: ZP.border };
  const titles: Record<Mode, string> = {
    sign_in: "Sign in",
    sign_up: "Create your account",
    verify: "Check your email",
    forgot: "Reset your password",
    reset: "Choose a new password",
  };
  const submitLabels: Record<Mode, string> = {
    sign_in: "Sign in",
    sign_up: "Create account",
    verify: "Confirm",
    forgot: "Email me a code",
    reset: "Save and sign in",
  };

  return (
    <div className="space-y-4">
      <h1 className="text-center text-xl font-black">{titles[mode]}</h1>

      {mode === "sign_in" ? (
        <>
          <AppleSignInButton mode="sign_in" />
          <div className="flex items-center gap-3 text-xs font-bold" style={{ color: ZP.muted }}>
            <span className="h-px flex-1" style={{ backgroundColor: ZP.border }} />
            or
            <span className="h-px flex-1" style={{ backgroundColor: ZP.border }} />
          </div>
        </>
      ) : null}

      {mode === "verify" || mode === "reset" ? (
        <p className="text-center text-sm font-semibold" style={{ color: ZP.muted }}>
          We emailed a 6-digit code to <strong>{sentTo}</strong>. It expires in 15 minutes.
        </p>
      ) : null}

      <form onSubmit={submit} className="space-y-3" noValidate>
        {mode === "sign_in" ? (
          <>
            <Field label="Username or email">
              <input className={inputClass} style={style} value={form.login} onChange={set("login")}
                autoComplete="username" autoCapitalize="none" autoCorrect="off" required />
            </Field>
            <Field label="Password">
              <input className={inputClass} style={style} type="password" value={form.password}
                onChange={set("password")} autoComplete="current-password" required />
            </Field>
          </>
        ) : null}

        {mode === "sign_up" ? (
          <>
            <div className="grid grid-cols-2 gap-2.5">
              <Field label="First name">
                <input className={inputClass} style={style} value={form.firstName} onChange={set("firstName")}
                  autoComplete="given-name" required />
              </Field>
              <Field label="Last name">
                <input className={inputClass} style={style} value={form.lastName} onChange={set("lastName")}
                  autoComplete="family-name" required />
              </Field>
            </div>
            <Field label="Email">
              <input className={inputClass} style={style} type="email" value={form.email} onChange={set("email")}
                autoComplete="email" autoCapitalize="none" inputMode="email" required />
            </Field>
            <Field label="Username">
              <input className={inputClass} style={style} value={form.username} onChange={set("username")}
                autoComplete="username" autoCapitalize="none" autoCorrect="off" required />
            </Field>
            <Field label="Password (at least 8 characters)">
              <input className={inputClass} style={style} type="password" value={form.password}
                onChange={set("password")} autoComplete="new-password" required />
            </Field>
          </>
        ) : null}

        {mode === "forgot" ? (
          <Field label="Email on your account">
            <input className={inputClass} style={style} type="email" value={form.email} onChange={set("email")}
              autoComplete="email" autoCapitalize="none" inputMode="email" required />
          </Field>
        ) : null}

        {mode === "verify" || mode === "reset" ? (
          <Field label="6-digit code">
            <input className={`${inputClass} text-center tracking-[0.4em]`} style={style} value={form.code}
              onChange={set("code")} inputMode="numeric" autoComplete="one-time-code" maxLength={6} required />
          </Field>
        ) : null}

        {mode === "reset" ? (
          <Field label="New password (at least 8 characters)">
            <input className={inputClass} style={style} type="password" value={form.password}
              onChange={set("password")} autoComplete="new-password" required />
          </Field>
        ) : null}

        {error ? (
          <p role="alert" className="rounded-xl p-3 text-left text-sm font-semibold"
            style={{ backgroundColor: ZP.dangerSoft, color: ZP.danger }}>
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={busy}
          className="flex min-h-12 w-full items-center justify-center rounded-full font-extrabold text-white disabled:opacity-60"
          style={{ backgroundColor: ZP.accent }}
        >
          {busy ? "One moment…" : submitLabels[mode]}
        </button>
      </form>

      <div className="flex flex-col items-center gap-2">
        {mode === "sign_in" ? (
          <>
            <TextLink onClick={() => go("forgot")}>Forgot password?</TextLink>
            <p className="text-sm font-semibold" style={{ color: ZP.muted }}>
              New to ZenPaws? <TextLink onClick={() => go("sign_up")}>Create an account</TextLink>
            </p>
          </>
        ) : mode === "sign_up" ? (
          <p className="text-sm font-semibold" style={{ color: ZP.muted }}>
            Already have an account? <TextLink onClick={() => go("sign_in")}>Sign in</TextLink>
          </p>
        ) : (
          <TextLink onClick={() => go("sign_in")}>Back to sign in</TextLink>
        )}
      </div>
    </div>
  );
}
