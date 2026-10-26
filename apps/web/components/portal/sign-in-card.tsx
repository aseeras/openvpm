import { LockKeyhole, MessageSquare, Phone } from "lucide-react";
import { ZP } from "@/lib/portal/zenpaws-theme";
import {
  ZENPAWS_PHONE_DISPLAY,
  ZENPAWS_PHONE_SMS,
  ZENPAWS_PHONE_TEL,
} from "@/lib/portal/zenpaws-guest";

/**
 * Shown when a visitor without a session taps something that needs one.
 * Clients sign in with the secure link the clinic texts or emails them.
 */
export function SignInCard({ reason }: { reason?: string }) {
  return (
    <section className="mt-6 rounded-3xl border bg-white p-6 text-center" style={{ borderColor: ZP.border }}>
      <span
        className="mx-auto flex h-12 w-12 items-center justify-center rounded-full"
        style={{ backgroundColor: ZP.chip, color: ZP.accent }}
      >
        <LockKeyhole className="h-6 w-6" aria-hidden="true" />
      </span>
      <h1 className="mt-3 text-xl font-black">Sign in to continue</h1>
      <p className="mt-2 text-sm leading-relaxed" style={{ color: ZP.muted }}>
        {reason ?? "This part of the app is for ZenPaws clients."} Already a
        client? Tap the sign-in link we texted or emailed you and the app opens
        signed in. Need a new link? Call or text us.
      </p>
      <div className="mt-5 grid grid-cols-2 gap-2.5">
        <a
          href={ZENPAWS_PHONE_TEL}
          className="flex min-h-12 items-center justify-center gap-2 rounded-full font-extrabold text-white"
          style={{ backgroundColor: ZP.accent }}
        >
          <Phone className="h-4 w-4" aria-hidden="true" />
          Call
        </a>
        <a
          href={ZENPAWS_PHONE_SMS}
          className="flex min-h-12 items-center justify-center gap-2 rounded-full font-extrabold"
          style={{ backgroundColor: ZP.sun, color: ZP.ink }}
        >
          <MessageSquare className="h-4 w-4" aria-hidden="true" />
          Text us
        </a>
      </div>
      <p className="mt-3 text-xs font-semibold" style={{ color: ZP.muted }}>
        {ZENPAWS_PHONE_DISPLAY}
      </p>
    </section>
  );
}
