"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  CalendarDays,
  ChevronLeft,
  ClipboardList,
  Home as HomeIcon,
  Syringe,
  Video,
  X,
} from "lucide-react";
import { ZP } from "@/lib/portal/zenpaws-theme";
import { PetAvatar } from "@/components/portal/pet-avatar";
import { PortalAuth } from "@/components/portal/portal-auth";
import {
  TELEHEALTH_FEE_LABEL,
  TELEHEALTH_REASONS,
  TELEHEALTH_VISIT_LABEL,
} from "@/lib/telehealth/visits";

/**
 * Working previews of the private screens for visitors who haven't signed
 * up yet. They use sample pets so people can see how the app works; the
 * first real action (joining the waiting room, booking) asks them to create
 * an account or sign in.
 */

const SAMPLE_PETS = [
  { id: "rusty", name: "Rusty", detail: "Golden Retriever · 12 yrs", photoUrl: "/demo/rusty.jpg", established: true },
  { id: "pepper", name: "Pepper", detail: "Beagle mix · 9 yrs", photoUrl: "/demo/pepper.jpg", established: false },
] as const;

function SampleBadge() {
  return (
    <span
      className="rounded-full px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wide"
      style={{ backgroundColor: ZP.sunSoft, color: ZP.sunInk }}
    >
      Sample
    </span>
  );
}

function PreviewBanner({ onJoin }: { onJoin: () => void }) {
  return (
    <div className="mb-4 flex items-center gap-3 rounded-2xl p-3" style={{ backgroundColor: ZP.chip }}>
      <p className="flex-1 text-[13px] font-semibold leading-snug">
        You&apos;re looking at a preview with sample pets.
      </p>
      <button
        type="button"
        onClick={onJoin}
        className="shrink-0 rounded-full px-3.5 py-2 text-[13px] font-extrabold text-white"
        style={{ backgroundColor: ZP.accent }}
      >
        Sign up
      </button>
    </div>
  );
}

/** Bottom sheet that asks for an account at the moment it's needed. */
function AuthSheet({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40" role="dialog" aria-modal="true" aria-label="Create an account">
      <div
        className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-white p-5"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 20px)" }}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <p className="text-sm font-semibold" style={{ color: ZP.muted }}>{message}</p>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border"
            style={{ borderColor: ZP.border }}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <PortalAuth initialMode="sign_up" />
      </div>
    </div>
  );
}

function useAuthSheet() {
  const [message, setMessage] = useState<string | null>(null);
  return {
    ask: (text: string) => setMessage(text),
    sheet: message ? <AuthSheet message={message} onClose={() => setMessage(null)} /> : null,
  };
}

function Header({ title, kicker, backHref }: { title: string; kicker?: string; backHref?: string }) {
  return (
    <div className="mb-4 flex items-center gap-3">
      {backHref ? (
        <Link
          href={backHref}
          aria-label="Back"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border bg-white"
          style={{ borderColor: ZP.border }}
        >
          <ChevronLeft className="h-5 w-5" aria-hidden="true" />
        </Link>
      ) : null}
      <div>
        {kicker ? (
          <p className="text-xs font-extrabold uppercase tracking-[0.1em]" style={{ color: ZP.accent }}>{kicker}</p>
        ) : null}
        <h1 className="text-[26px] font-black leading-tight">{title}</h1>
      </div>
    </div>
  );
}

function Card({ children }: { children: ReactNode }) {
  return (
    <section className="rounded-[18px] border bg-white p-4" style={{ borderColor: ZP.border }}>
      {children}
    </section>
  );
}

/** "Step 1 of 2" of a video visit, fully clickable, with sample pets. */
export function GuestVideoPreview() {
  const { ask, sheet } = useAuthSheet();
  const [petId, setPetId] = useState<string>("rusty");
  const [reason, setReason] = useState<string>(TELEHEALTH_REASONS[0]);
  const [notes, setNotes] = useState("");

  return (
    <div>
      <Header kicker="Step 1 of 2" title="What's going on?" backHref="/portal" />
      <PreviewBanner onJoin={() => ask("Create a free account to start real video visits with the veterinarian.")} />

      <div className="space-y-4">
        <fieldset>
          <legend className="mb-2 text-sm font-extrabold">Who is this visit for?</legend>
          <div className="grid grid-cols-2 gap-2.5">
            {SAMPLE_PETS.map((pet) => {
              const selected = petId === pet.id;
              return (
                <button
                  key={pet.id}
                  type="button"
                  disabled={!pet.established}
                  aria-pressed={selected}
                  onClick={() => setPetId(pet.id)}
                  className={`flex min-h-[60px] items-center gap-2.5 rounded-[18px] border-2 p-2.5 text-left ${pet.established ? "" : "cursor-not-allowed opacity-60"}`}
                  style={{ borderColor: selected ? ZP.accent : ZP.border, backgroundColor: selected ? ZP.chip : "#fff" }}
                >
                  <PetAvatar name={pet.name} photoUrl={pet.photoUrl} size={40} />
                  <span className="min-w-0">
                    <span className="block truncate text-base font-extrabold">{pet.name}</span>
                    {!pet.established ? (
                      <span className="block text-[11px] font-semibold leading-tight" style={{ color: ZP.muted }}>
                        Needs an in-person first visit
                      </span>
                    ) : null}
                  </span>
                </button>
              );
            })}
          </div>
        </fieldset>

        <fieldset>
          <legend className="mb-2 text-sm font-extrabold">Reason for the visit</legend>
          <div className="flex flex-wrap gap-2">
            {TELEHEALTH_REASONS.map((item) => {
              const on = reason === item;
              return (
                <button
                  key={item}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setReason(item)}
                  className="h-10 rounded-full border px-3.5 text-sm font-bold"
                  style={{ backgroundColor: on ? ZP.ink : "#fff", color: on ? "#fff" : ZP.ink, borderColor: on ? ZP.ink : "#C4DDF2" }}
                >
                  {item}
                </button>
              );
            })}
          </div>
        </fieldset>

        <label className="block">
          <span className="mb-1.5 block text-sm font-extrabold">Anything the veterinarian should know?</span>
          <textarea
            value={notes}
            rows={3}
            onChange={(event) => setNotes(event.currentTarget.value)}
            placeholder="e.g. Stiffer getting up this week, still eating well"
            className="w-full resize-none rounded-2xl border bg-white px-3.5 py-3 text-[15px]"
            style={{ borderColor: "#C4DDF2", color: ZP.ink }}
          />
        </label>

        <div role="note" className="flex items-start gap-2.5 rounded-2xl p-3.5" style={{ backgroundColor: ZP.dangerSoft }}>
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" style={{ color: ZP.danger }} aria-hidden="true" />
          <span className="text-[13px] font-semibold leading-snug text-[#6E140E]">
            Trouble breathing, collapse, bloated belly or a toxin? Go to your nearest 24-hour emergency hospital now.
          </span>
        </div>

        <Card>
          <div className="flex items-baseline justify-between">
            <span className="text-sm font-bold" style={{ color: ZP.muted }}>{TELEHEALTH_VISIT_LABEL}</span>
            <span className="text-base font-black">{TELEHEALTH_FEE_LABEL}</span>
          </div>
          <button
            type="button"
            onClick={() => ask("Create a free account to join the waiting room. Video visits are for pets we've already seen in person.")}
            className="mt-3 flex h-[52px] w-full items-center justify-center gap-2 rounded-full font-extrabold text-white"
            style={{ backgroundColor: ZP.accent }}
          >
            Continue to waiting room
          </button>
        </Card>

        <section className="space-y-2">
          <h2 className="text-lg font-extrabold">What happens next</h2>
          {[
            ["Virtual waiting room", "Check your camera and mic while the veterinarian gets ready."],
            ["Video visit", "Show us how your pet is moving, eating or healing, from home."],
            ["Visit summary", "Notes, next steps and any refills appear in the app afterwards."],
          ].map(([title, detail], index) => (
            <div key={title} className="flex items-start gap-3 rounded-[18px] border bg-white p-3.5" style={{ borderColor: ZP.border }}>
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-black" style={{ backgroundColor: ZP.sunSoft, color: ZP.sunInk }}>
                {index + 2}
              </span>
              <span>
                <span className="block text-[15px] font-extrabold">{title}</span>
                <span className="block text-[13px] font-semibold" style={{ color: ZP.muted }}>{detail}</span>
              </span>
            </div>
          ))}
        </section>
      </div>
      {sheet}
    </div>
  );
}

/** The Visits tab with a sample upcoming house call and a past visit. */
export function GuestVisitsPreview() {
  const { ask, sheet } = useAuthSheet();
  return (
    <div className="space-y-4">
      <Header title="Visits" />
      <PreviewBanner onJoin={() => ask("Create a free account to book and manage your visits.")} />

      <div className="grid grid-cols-2 gap-2.5">
        <Link
          href="/portal/video"
          className="flex min-h-14 items-center justify-center gap-2 rounded-[18px] font-extrabold"
          style={{ backgroundColor: ZP.sun, color: ZP.ink }}
        >
          <Video className="h-5 w-5" aria-hidden="true" /> Video visit
        </Link>
        <button
          type="button"
          onClick={() => ask("Create a free account to book a house call.")}
          className="flex min-h-14 items-center justify-center gap-2 rounded-[18px] font-extrabold text-white"
          style={{ backgroundColor: ZP.accent }}
        >
          <HomeIcon className="h-5 w-5" aria-hidden="true" /> House call
        </button>
      </div>

      <h2 className="text-lg font-extrabold">Coming up</h2>
      <button
        type="button"
        onClick={() => ask("Create a free account to see and change your own visits.")}
        className="flex w-full items-center gap-3 rounded-[18px] p-3.5 text-left"
        style={{ backgroundColor: ZP.sunSoft }}
      >
        <span className="flex h-14 w-[52px] shrink-0 flex-col items-center justify-center rounded-[14px] bg-white">
          <span className="text-[11px] font-extrabold tracking-wide text-[#B3261E]">THU</span>
          <span className="text-[22px] font-black leading-none">14</span>
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-[15px] font-extrabold">
            Acupuncture follow-up · Rusty <SampleBadge />
          </span>
          <span className="block text-[13px] font-semibold" style={{ color: ZP.sunInk }}>3:00 PM · House call at your home</span>
        </span>
      </button>

      <h2 className="text-lg font-extrabold">Past visits</h2>
      <Card>
        <div className="flex items-center gap-3">
          <PetAvatar name="Rusty" photoUrl="/demo/rusty.jpg" size={44} />
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-2 font-extrabold">Video recheck · Rusty <SampleBadge /></p>
            <p className="text-[13px] font-semibold" style={{ color: ZP.muted }}>12 min · Visit summary and next steps</p>
          </div>
        </div>
        <p className="mt-3 rounded-2xl p-3 text-[13px] font-semibold leading-relaxed" style={{ backgroundColor: ZP.surface }}>
          &ldquo;Hips looking looser since last week. Keep the evening walks short,
          continue joint supplement, recheck after the next acupuncture session.&rdquo;
        </p>
      </Card>
      {sheet}
    </div>
  );
}

/** The Pets tab with sample pets and what a pet's record holds. */
export function GuestPetsPreview() {
  const { ask, sheet } = useAuthSheet();
  return (
    <div className="space-y-4">
      <Header title="Pets" />
      <PreviewBanner onJoin={() => ask("Create a free account to see your own pets' records.")} />
      <div className="space-y-2.5">
        {SAMPLE_PETS.map((pet) => (
          <button
            key={pet.id}
            type="button"
            onClick={() => ask("Create a free account to see your own pets' full records.")}
            className="flex w-full items-center gap-3 rounded-[18px] border bg-white p-3 text-left"
            style={{ borderColor: ZP.border }}
          >
            <PetAvatar name={pet.name} photoUrl={pet.photoUrl} size={56} />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2 text-lg font-extrabold">{pet.name} <SampleBadge /></span>
              <span className="block text-[13px] font-semibold" style={{ color: ZP.muted }}>{pet.detail}</span>
            </span>
          </button>
        ))}
      </div>

      <h2 className="text-lg font-extrabold">In each pet&apos;s record</h2>
      <div className="grid grid-cols-2 gap-2.5">
        {[
          { icon: ClipboardList, title: "Visit notes", detail: "Treatment plans and summaries" },
          { icon: Syringe, title: "Vaccines", detail: "What's due and when" },
          { icon: CalendarDays, title: "Appointments", detail: "Upcoming and past visits" },
          { icon: Video, title: "Video rechecks", detail: "Quick follow-ups from home" },
        ].map((item) => (
          <div key={item.title} className="rounded-[18px] border bg-white p-3.5" style={{ borderColor: ZP.border }}>
            <item.icon className="h-6 w-6" style={{ color: ZP.accent }} aria-hidden="true" />
            <p className="mt-2 text-[15px] font-extrabold">{item.title}</p>
            <p className="text-[12px] font-semibold" style={{ color: ZP.muted }}>{item.detail}</p>
          </div>
        ))}
      </div>
      {sheet}
    </div>
  );
}
