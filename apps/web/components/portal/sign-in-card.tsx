import { LockKeyhole } from "lucide-react";
import { ZP } from "@/lib/portal/zenpaws-theme";
import { PortalAuth } from "@/components/portal/portal-auth";

/**
 * Shown when a visitor without a session opens a private screen: sign in
 * (Apple, or username and password), create an account, or reset a password.
 */
export function SignInCard({ reason }: { reason?: string }) {
  return (
    <section className="mt-2 space-y-4 rounded-3xl border bg-white p-6" style={{ borderColor: ZP.border }}>
      <div className="flex items-center gap-3 rounded-2xl p-3" style={{ backgroundColor: ZP.chip }}>
        <LockKeyhole className="h-5 w-5 shrink-0" style={{ color: ZP.accent }} aria-hidden="true" />
        <p className="text-sm font-semibold" style={{ color: ZP.ink }}>
          {reason ?? "This part of the app is for ZenPaws clients."}
        </p>
      </div>
      <PortalAuth />
      <p className="text-center text-xs" style={{ color: ZP.muted }}>
        Got a sign-in link from us? Tap it and the app opens signed in.
      </p>
    </section>
  );
}
