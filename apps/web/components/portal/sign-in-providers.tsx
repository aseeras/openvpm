"use client";

import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { ZP } from "@/lib/portal/zenpaws-theme";
import { AppleSignInButton } from "@/components/portal/apple-sign-in-button";
import { nativeAppleSignInAvailable } from "@/lib/portal/native-apple-sign-in";

const SSO_ERRORS: Record<string, string> = {
  cancelled: "Sign-in was cancelled. You can try again or use your username and password.",
  expired: "That sign-in took too long or was started in another tab. Please try again.",
  failed: "We couldn't confirm that sign-in. Please try again.",
  not_linked:
    "We couldn't set up an account from that sign-in. Sign in with your username and password, or create an account.",
  busy: "Too many attempts. Please wait a few minutes and try again.",
  unavailable: "That sign-in option isn't available right now. Please use your username and password.",
};

function AppleLogo() {
  return (
    <svg viewBox="0 0 17 20" className="h-[18px] w-[18px]" fill="currentColor" aria-hidden="true">
      <path d="M14.2 10.6c0-2.6 2.1-3.8 2.2-3.9-1.2-1.8-3.1-2-3.7-2-1.6-.2-3.1.9-3.9.9-.8 0-2.1-.9-3.4-.9C3.6 4.7 2 5.7 1.1 7.3c-1.9 3.2-.5 8 1.3 10.6.9 1.3 1.9 2.7 3.3 2.7 1.3-.1 1.8-.9 3.4-.9 1.6 0 2 .9 3.4.8 1.4 0 2.3-1.3 3.2-2.6 1-1.5 1.4-2.9 1.4-3-.1 0-2.9-1.1-2.9-4.3ZM11.6 3c.7-.9 1.2-2.1 1.1-3.3-1 0-2.3.7-3 1.6-.7.8-1.3 2-1.1 3.2 1.1.1 2.3-.6 3-1.5Z" />
    </svg>
  );
}

function GoogleLogo() {
  return (
    <svg viewBox="0 0 18 18" className="h-[18px] w-[18px]" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z" />
      <path fill="#FBBC05" d="M3.97 10.72A5.41 5.41 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.05l3.01-2.33Z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z" />
    </svg>
  );
}

const buttonClass =
  "flex min-h-12 w-full items-center justify-center gap-2 rounded-full text-[17px] font-semibold no-underline";

/**
 * The single sign-on buttons above the username and password form. Inside the
 * iPhone app, Apple's native sheet; in a browser, Apple and Google's own
 * sign-in pages. Google doesn't allow its sign-in inside an app's web view, so
 * the app shows Apple only. Renders nothing (not even the "or") when no
 * provider is set up.
 */
export function SignInProviders() {
  const [native, setNative] = useState<boolean | null>(null);
  const [ssoError, setSsoError] = useState<string | null>(null);
  const options = trpc.portalSignIn.options.useQuery(undefined, {
    enabled: native !== null,
    staleTime: 10 * 60 * 1000,
  });

  useEffect(() => {
    setNative(nativeAppleSignInAvailable());
    const code = new URLSearchParams(window.location.search).get("sso_error");
    if (code) setSsoError(SSO_ERRORS[code] ?? SSO_ERRORS.failed!);
  }, []);

  const showNativeApple = Boolean(native && options.data?.apple);
  const showWebApple = native === false && Boolean(options.data?.web.apple);
  const showGoogle = native === false && Boolean(options.data?.web.google);
  const any = showNativeApple || showWebApple || showGoogle;

  return (
    <>
      {ssoError ? (
        <p role="alert" className="rounded-xl p-3 text-left text-sm font-semibold" style={{ backgroundColor: ZP.dangerSoft, color: ZP.danger }}>
          {ssoError}
        </p>
      ) : null}
      {any ? (
        <>
          <div className="space-y-2.5">
            {showNativeApple ? <AppleSignInButton mode="sign_in" /> : null}
            {showWebApple ? (
              <a href="/api/portal/sso/apple/start" className={`${buttonClass} bg-black text-white`}>
                <AppleLogo />
                Continue with Apple
              </a>
            ) : null}
            {showGoogle ? (
              <a
                href="/api/portal/sso/google/start"
                className={`${buttonClass} border bg-white`}
                style={{ borderColor: ZP.border, color: "#1f1f1f" }}
              >
                <GoogleLogo />
                Continue with Google
              </a>
            ) : null}
          </div>
          <div className="flex items-center gap-3 text-xs font-bold" style={{ color: ZP.muted }}>
            <span className="h-px flex-1" style={{ backgroundColor: ZP.border }} />
            or
            <span className="h-px flex-1" style={{ backgroundColor: ZP.border }} />
          </div>
        </>
      ) : null}
    </>
  );
}
