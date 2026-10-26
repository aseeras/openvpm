"use client";

import Link from "next/link";
import {
  AlertCircle,
  Bell,
  ChevronRight,
  FileText,
  Home as HomeIcon,
  MessageSquare,
  Pill,
  Video,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { calculatePortalAge } from "@/lib/portal/date";
import { portalLogo, ZP } from "@/lib/portal/zenpaws-theme";
import { PetAvatar } from "@/components/portal/pet-avatar";
import { GuestHome } from "@/components/portal/guest-home";

const UPCOMING_STATUSES = new Set(["scheduled", "confirmed", "checked_in"]);

function speciesLabel(species: string | null, breed: string | null): string {
  if (breed) return breed.split(/[\s/]/)[0] ?? breed;
  if (!species) return "";
  return species === "canine" ? "Dog" : species === "feline" ? "Cat" : species.charAt(0).toUpperCase() + species.slice(1);
}

export default function PortalHomePage() {
  const { data, isLoading, error } = trpc.portal.getClient.useQuery({}, { retry: false });
  const video = trpc.portalTelehealth.status.useQuery(undefined, {
    enabled: Boolean(data),
    refetchInterval: 30_000,
  });
  const appointments = trpc.portal.getAppointments.useQuery({}, { enabled: Boolean(data) });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div
          className="h-8 w-8 animate-spin rounded-full border-4 border-t-transparent"
          style={{ borderColor: ZP.accent, borderTopColor: "transparent" }}
        />
      </div>
    );
  }

  // No session yet: show what ZenPaws offers instead of a sign-in wall.
  if (error?.data?.code === "UNAUTHORIZED") {
    return <GuestHome />;
  }

  if (error || !data) {
    return (
      <section className="mt-16 rounded-3xl border bg-white p-7 text-center" style={{ borderColor: ZP.border }}>
        <AlertCircle className="mx-auto h-8 w-8" style={{ color: ZP.accent }} aria-hidden="true" />
        <h1 className="mt-3 text-xl font-black">Sign in to ZenPaws</h1>
        <p className="mt-2 text-sm" style={{ color: ZP.muted }}>
          Open the sign-in link the clinic sent you. Need a new one? Call or text us.
        </p>
        <a
          href="tel:+13123714652"
          className="mt-5 inline-flex min-h-12 w-full items-center justify-center rounded-full font-extrabold text-white"
          style={{ backgroundColor: ZP.accent }}
        >
          Call (312) 371-4652
        </a>
      </section>
    );
  }

  const now = Date.now();
  const nextVisit = (appointments.data ?? [])
    .filter((a) => UPCOMING_STATUSES.has(a.status) && new Date(a.startTime).getTime() > now - 60 * 60 * 1000)
    .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())[0];
  const accepting = video.data?.configured && video.data.accepting;
  const inWaitingRoom = video.data?.visit;

  return (
    <div className="space-y-5">
      {/* Greeting */}
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={portalLogo(data.practice.logoUrl)}
            alt={`${data.practice.name} logo`}
            className="h-12 w-12 rounded-2xl border bg-white object-cover"
            style={{ borderColor: ZP.border }}
          />
          <div>
            <p className="text-[13px] font-extrabold uppercase tracking-[0.12em]">{data.practice.name}</p>
            <h1 className="text-[26px] font-black leading-tight">Hi, {data.firstName}</h1>
          </div>
        </div>
        <Link
          href="/portal/messages"
          aria-label="Messages"
          className="flex h-11 w-11 items-center justify-center rounded-full border bg-white"
          style={{ borderColor: ZP.border }}
        >
          <Bell className="h-5 w-5" aria-hidden="true" />
        </Link>
      </header>

      {/* Video visit */}
      <section className="space-y-3.5 rounded-3xl p-5 text-white" style={{ backgroundColor: ZP.accent }}>
        <div className="flex items-center gap-3">
          <div className="relative h-[52px] w-[52px] shrink-0">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={portalLogo(data.practice.logoUrl)}
              alt=""
              className="h-[52px] w-[52px] rounded-full border-2 border-white bg-white object-cover"
            />
            {accepting ? (
              <span
                className="absolute bottom-0.5 right-0 h-3.5 w-3.5 rounded-full border-2"
                style={{ backgroundColor: "#2FB36B", borderColor: ZP.accent }}
              />
            ) : null}
          </div>
          <div>
            <p className="text-lg font-extrabold">Video visit with the veterinarian</p>
            <p className="text-sm font-semibold text-[#DCEEFC]">
              {inWaitingRoom
                ? inWaitingRoom.status === "in_call"
                  ? "Your visit is in progress"
                  : "You're in the waiting room"
                : accepting
                  ? "Available now"
                  : "Not available right now"}
            </p>
          </div>
        </div>
        <p className="text-sm leading-relaxed text-[#EAF5FE]">
          Quick rechecks, medication questions and acupuncture follow-ups from
          your couch. For established {data.practice.name} patients.
        </p>
        <Link
          href="/portal/video"
          className="flex h-[50px] items-center justify-center gap-2 rounded-full font-extrabold"
          style={{ backgroundColor: ZP.sun, color: ZP.ink }}
        >
          <Video className="h-5 w-5" aria-hidden="true" />
          {inWaitingRoom ? "Return to your visit" : "Start a video visit"}
        </Link>
      </section>

      {/* Quick actions */}
      <section className="grid grid-cols-4 gap-2.5" aria-label="Quick actions">
        {[
          { href: "/portal/book", label: "House call", icon: HomeIcon, tint: ZP.sunSoft },
          { href: "/portal/messages", label: "Message", icon: MessageSquare, tint: ZP.chip },
          { href: "/portal/messages?topic=refill", label: "Refills", icon: Pill, tint: ZP.chip },
          { href: "/portal/pets", label: "Records", icon: FileText, tint: ZP.chip },
        ].map((action) => (
          <Link
            key={action.label}
            href={action.href}
            className="flex flex-col items-center gap-2 rounded-[18px] border bg-white px-1 py-3"
            style={{ borderColor: ZP.border }}
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-xl" style={{ backgroundColor: action.tint }}>
              <action.icon className="h-[22px] w-[22px]" aria-hidden="true" />
            </span>
            <span className="text-center text-xs font-bold leading-tight">{action.label}</span>
          </Link>
        ))}
      </section>

      {/* Pets */}
      <section className="space-y-2.5">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-extrabold">My pets</h2>
          <Link href="/portal/messages?topic=new-pet" className="text-sm font-bold" style={{ color: ZP.accent }}>
            Add a pet
          </Link>
        </div>
        {data.patients.length === 0 ? (
          <p className="rounded-[18px] border bg-white p-4 text-sm" style={{ borderColor: ZP.border, color: ZP.muted }}>
            Your pets will appear here once the clinic adds them.
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-2.5">
            {data.patients.map((pet) => (
              <Link
                key={pet.id}
                href={`/portal/pets/${pet.id}`}
                className="flex items-center gap-2.5 rounded-[18px] border bg-white p-2.5"
                style={{ borderColor: ZP.border }}
              >
                <PetAvatar name={pet.name} photoUrl={pet.photoUrl} />
                <span className="min-w-0">
                  <span className="block truncate text-base font-extrabold">{pet.name}</span>
                  <span className="block truncate text-xs font-semibold" style={{ color: ZP.muted }}>
                    {[speciesLabel(pet.species, pet.breed), pet.dob ? calculatePortalAge(pet.dob) : null]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* Coming up */}
      <section className="space-y-2.5">
        <h2 className="text-lg font-extrabold">Coming up</h2>
        {nextVisit ? (
          <Link
            href="/portal/appointments"
            className="flex items-center gap-3 rounded-[18px] p-3.5"
            style={{ backgroundColor: ZP.sunSoft }}
          >
            <span className="flex h-14 w-[52px] shrink-0 flex-col items-center justify-center rounded-[14px] bg-white">
              <span className="text-[11px] font-extrabold tracking-wide text-[#B3261E]">
                {new Date(nextVisit.startTime)
                  .toLocaleDateString("en-US", { weekday: "short", timeZone: nextVisit.timezone ?? undefined })
                  .toUpperCase()}
              </span>
              <span className="text-[22px] font-black leading-none">
                {new Date(nextVisit.startTime).toLocaleDateString("en-US", {
                  day: "numeric",
                  timeZone: nextVisit.timezone ?? undefined,
                })}
              </span>
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] font-extrabold">
                {nextVisit.typeName ?? "Visit"} · {nextVisit.patientName}
              </span>
              <span className="block truncate text-[13px] font-semibold" style={{ color: ZP.sunInk }}>
                {new Date(nextVisit.startTime).toLocaleTimeString("en-US", {
                  hour: "numeric",
                  minute: "2-digit",
                  timeZone: nextVisit.timezone ?? undefined,
                })}
                {nextVisit.locationName ? ` · ${nextVisit.locationName}` : ""}
              </span>
            </span>
            <ChevronRight className="h-5 w-5 shrink-0" style={{ color: ZP.sunInk }} aria-hidden="true" />
          </Link>
        ) : (
          <Link
            href="/portal/book"
            className="flex items-center justify-between rounded-[18px] border bg-white p-4 text-sm font-bold"
            style={{ borderColor: ZP.border }}
          >
            Nothing booked yet. Book a house call
            <ChevronRight className="h-5 w-5" aria-hidden="true" />
          </Link>
        )}
      </section>
    </div>
  );
}
