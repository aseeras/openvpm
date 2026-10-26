"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronRight, LogOut, Mail, MessageSquare, Phone, Receipt } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { ZP } from "@/lib/portal/zenpaws-theme";

/** The client's details, the clinic's contact details, and sign-out. */
export default function PortalAccountPage() {
  const { data } = trpc.portal.getClient.useQuery({});
  const [signingOut, setSigningOut] = useState(false);

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
