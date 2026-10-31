"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronRight, LogOut, Mail, MessageSquare, Phone, Receipt } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { ZP } from "@/lib/portal/zenpaws-theme";
import { AppleSignInButton } from "@/components/portal/apple-sign-in-button";
import { nativeAppleSignInAvailable } from "@/lib/portal/native-apple-sign-in";

const LINK_ERRORS: Record<string, string> = {
  cancelled: "Sign in with Apple wasn't turned on. You can try again any time.",
  expired: "That took too long or was started in another tab. Please try again.",
  failed: "We couldn't confirm that Apple ID. Please try again.",
  taken: "This Apple ID is already connected to another ZenPaws account.",
  signed_out: "Your session ended. Sign in again, then turn on Sign in with Apple.",
  busy: "Too many attempts. Please wait a few minutes and try again.",
  unavailable: "Sign in with Apple isn't available right now. Please try again later.",
};

/** The client's details, the clinic's contact details, and sign-out. */
export default function PortalAccountPage() {
  const { data } = trpc.portal.getClient.useQuery({});
  const [signingOut, setSigningOut] = useState(false);
  const [inApp, setInApp] = useState(false);
  const [linkNotice, setLinkNotice] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    setInApp(nativeAppleSignInAvailable());
    const query = new URLSearchParams(window.location.search);
    if (query.get("sso_linked") === "apple") {
      setLinkNotice({ ok: true, text: "Sign in with Apple is on." });
    } else {
      const error = query.get("sso_error");
      if (error) setLinkNotice({ ok: false, text: LINK_ERRORS[error] ?? LINK_ERRORS.failed! });
    }
    if (query.has("sso_linked") || query.has("sso_error")) {
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);
  const signIn = trpc.portalSignIn.status.useQuery(undefined, { enabled: Boolean(data) });
  const unlinkApple = trpc.portalSignIn.unlinkApple.useMutation({
    onSuccess: () => signIn.refetch(),
  });

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await fetch("/api/portal/session", { method: "DELETE" });
    } finally {
      window.location.replace("/portal");
    }
  }

  const row = "flex min-h-14 items-center gap-3 px-4 py-3";
  return (
    <div className="space-y-5">
      <h1 className="text-[26px] font-black">Account</h1>

      {data ? (
        <section className="rounded-[18px] border bg-white p-4" style={{ borderColor: ZP.border }}>
          <p className="text-lg font-extrabold">{data.firstName} {data.lastName}</p>
          {data.email ? <p className="text-sm font-semibold" style={{ color: ZP.muted }}>{data.email}</p> : null}
          {data.phone ? <p className="text-sm font-semibold" style={{ color: ZP.muted }}>{data.phone}</p> : null}
          <p className="mt-2 text-xs" style={{ color: ZP.muted }}>
            To change these details, send the clinic a message.
          </p>
        </section>
      ) : null}

      {linkNotice ? (
        <p
          role={linkNotice.ok ? "status" : "alert"}
          className="rounded-xl p-3 text-sm font-semibold"
          style={linkNotice.ok ? { backgroundColor: ZP.sunSoft } : { backgroundColor: ZP.dangerSoft, color: ZP.danger }}
        >
          {linkNotice.text}
        </p>
      ) : null}

      {/* The iPhone app turns it on with Apple's sheet; a browser goes to Apple's page. Turning it off works anywhere. */}
      {signIn.data && (signIn.data.appleLinked || (inApp ? signIn.data.appleAvailable : signIn.data.appleWeb)) ? (
        <section className="space-y-2.5 rounded-[18px] border bg-white p-4" style={{ borderColor: ZP.border }}>
          <p className="font-extrabold">Sign in with Apple</p>
          {signIn.data.appleLinked ? (
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-semibold" style={{ color: ZP.muted }}>
                On. Next time, sign in with your Apple ID instead of a password or a link.
              </p>
              <button
                type="button"
                onClick={() => unlinkApple.mutate()}
                disabled={unlinkApple.isPending}
                className="shrink-0 text-sm font-extrabold disabled:opacity-60"
                style={{ color: ZP.danger }}
              >
                Turn off
              </button>
            </div>
          ) : (
            <>
              <p className="text-sm font-semibold" style={{ color: ZP.muted }}>
                Sign in with your Apple ID next time, on your phone or computer, without waiting for a link.
              </p>
              {inApp ? (
                <AppleSignInButton mode="link" onLinked={() => signIn.refetch()} />
              ) : (
                <a
                  href="/api/portal/sso/apple/start?intent=link"
                  className="flex min-h-12 w-full items-center justify-center rounded-full bg-black text-[17px] font-semibold text-white no-underline"
                >
                  Turn on Sign in with Apple
                </a>
              )}
            </>
          )}
        </section>
      ) : null}

      <section className="divide-y overflow-hidden rounded-[18px] border bg-white" style={{ borderColor: ZP.border }}>
        <Link href="/portal/messages" className={row}>
          <MessageSquare className="h-5 w-5" aria-hidden="true" />
          <span className="flex-1 font-bold">Messages</span>
          <ChevronRight className="h-5 w-5" style={{ color: ZP.muted }} aria-hidden="true" />
        </Link>
        <Link href="/portal/invoices" className={row}>
          <Receipt className="h-5 w-5" aria-hidden="true" />
          <span className="flex-1 font-bold">Invoices and payments</span>
          <ChevronRight className="h-5 w-5" style={{ color: ZP.muted }} aria-hidden="true" />
        </Link>
      </section>

      {data ? (
        <section className="space-y-1 rounded-[18px] p-4" style={{ backgroundColor: ZP.sunSoft }}>
          <p className="font-extrabold">{data.practice.name}</p>
          {data.practice.phone ? (
            <a href={`tel:${data.practice.phone.replace(/[^\d+]/g, "")}`} className="flex min-h-10 items-center gap-2 text-sm font-bold">
              <Phone className="h-4 w-4" aria-hidden="true" /> {data.practice.phone}
            </a>
          ) : null}
          {data.practice.email ? (
            <a href={`mailto:${data.practice.email}`} className="flex min-h-10 items-center gap-2 text-sm font-bold">
              <Mail className="h-4 w-4" aria-hidden="true" /> {data.practice.email}
            </a>
          ) : null}
        </section>
      ) : null}

      <button
        type="button"
        onClick={signOut}
        disabled={signingOut}
        className="flex min-h-12 w-full items-center justify-center gap-2 rounded-full border bg-white font-extrabold disabled:opacity-60"
        style={{ borderColor: ZP.border }}
      >
        <LogOut className="h-4 w-4" aria-hidden="true" />
        {signingOut ? "Signing out…" : "Sign out"}
      </button>
      <p className="text-center text-xs" style={{ color: ZP.muted }}>
        <a href="/legal/privacy" className="underline">Privacy</a> · Powered by OpenVPM
      </p>
    </div>
  );
}
