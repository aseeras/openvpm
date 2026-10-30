import Link from "next/link";
import {
  Globe,
  Home as HomeIcon,
  LogIn,
  PawPrint,
  Sparkles,
  Video,
} from "lucide-react";
import { portalLogo, ZP } from "@/lib/portal/zenpaws-theme";
import {
  ZENPAWS_PRACTICE_NAME,
  ZENPAWS_SERVICES,
  ZENPAWS_WEBSITE,
} from "@/lib/portal/zenpaws-guest";

const STEPS = [
  { title: "Book a house call", detail: "Create a free account and pick a time that suits you and your pet." },
  { title: "Your first visit at home", detail: "A full exam and acupuncture where your pet is most relaxed." },
  { title: "Follow-ups your way", detail: "Back at home, or a quick video recheck from your couch." },
] as const;

/**
 * The app's front door for visitors who haven't signed in yet: what ZenPaws
 * does, what it costs and how to start, with sign-in only where it's needed.
 */
export function GuestHome() {
  return (
    <div className="space-y-5">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={portalLogo(null)}
            alt={`${ZENPAWS_PRACTICE_NAME} logo`}
            className="h-12 w-12 rounded-2xl border bg-white object-cover"
            style={{ borderColor: ZP.border }}
          />
          <div>
            <p className="text-[13px] font-extrabold uppercase tracking-[0.12em]">{ZENPAWS_PRACTICE_NAME}</p>
            <h1 className="text-[26px] font-black leading-tight">Welcome</h1>
          </div>
        </div>
        <Link
          href="/portal/account"
          className="flex h-11 items-center gap-1.5 rounded-full border bg-white px-4 text-sm font-extrabold"
          style={{ borderColor: ZP.border, color: ZP.accent }}
        >
          <LogIn className="h-4 w-4" aria-hidden="true" />
          Sign in
        </Link>
      </header>

      <section className="space-y-3.5 rounded-3xl p-5 text-white" style={{ backgroundColor: ZP.accent }}>
        <p className="text-[22px] font-black leading-tight">
          Holistic vet care that comes to you
        </p>
        <p className="text-sm leading-relaxed text-[#EAF5FE]">
          Acupuncture, rehab and herbal medicine in your home, where your pet
          is calm. Rechecks by video for pets we&apos;ve already met.
        </p>
        <Link
          href="/portal/book"
          className="flex h-[50px] items-center justify-center gap-2 rounded-full font-extrabold"
          style={{ backgroundColor: ZP.sun, color: ZP.ink }}
        >
          <HomeIcon className="h-5 w-5" aria-hidden="true" />
          Book a house call
        </Link>
      </section>

      <section className="grid grid-cols-4 gap-2.5" aria-label="Quick actions">
        {[
          { href: "/portal/video", label: "Video visit", icon: Video, tint: ZP.sunSoft, external: false },
          { href: "/portal/book", label: "House call", icon: HomeIcon, tint: ZP.chip, external: false },
          { href: "/portal/pets", label: "Pets", icon: PawPrint, tint: ZP.chip, external: false },
          { href: ZENPAWS_WEBSITE, label: "Website", icon: Globe, tint: ZP.chip, external: true },
        ].map((action) => {
          const content = (
            <>
              <span className="flex h-10 w-10 items-center justify-center rounded-xl" style={{ backgroundColor: action.tint }}>
                <action.icon className="h-[22px] w-[22px]" aria-hidden="true" />
              </span>
              <span className="text-center text-xs font-bold leading-tight">{action.label}</span>
            </>
          );
          const className = "flex flex-col items-center gap-2 rounded-[18px] border bg-white px-1 py-3";
          return action.external ? (
            <a key={action.label} href={action.href} className={className} style={{ borderColor: ZP.border }}>
              {content}
            </a>
          ) : (
            <Link key={action.label} href={action.href} className={className} style={{ borderColor: ZP.border }}>
              {content}
            </Link>
          );
        })}
      </section>

      <section className="space-y-2.5">
        <h2 className="text-lg font-extrabold">How it works</h2>
        <ol className="space-y-2">
          {STEPS.map((step, index) => (
            <li
              key={step.title}
              className="flex items-start gap-3 rounded-[18px] border bg-white p-3.5"
              style={{ borderColor: ZP.border }}
            >
              <span
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-black"
                style={{ backgroundColor: ZP.sunSoft, color: ZP.sunInk }}
              >
                {index + 1}
              </span>
              <span>
                <span className="block text-[15px] font-extrabold">{step.title}</span>
                <span className="block text-[13px] font-semibold" style={{ color: ZP.muted }}>
                  {step.detail}
                </span>
              </span>
            </li>
          ))}
        </ol>
      </section>

      <section className="space-y-2.5">
        <h2 className="text-lg font-extrabold">Services</h2>
        <ul className="divide-y rounded-[18px] border bg-white" style={{ borderColor: ZP.border }}>
          {ZENPAWS_SERVICES.map((service) => (
            <li key={service.name} className="flex items-start justify-between gap-3 p-3.5" style={{ borderColor: ZP.border }}>
              <span className="min-w-0">
                <span className="block text-[15px] font-extrabold">{service.name}</span>
                <span className="block text-[13px] font-semibold" style={{ color: ZP.muted }}>
                  {service.detail} · {service.duration}
                </span>
              </span>
              <span className="shrink-0 text-[15px] font-black" style={{ color: ZP.accent }}>
                {service.price}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <Link
        href="/portal/account"
        className="flex items-center gap-3 rounded-[18px] p-4"
        style={{ backgroundColor: ZP.sunSoft }}
      >
        <Sparkles className="h-6 w-6 shrink-0" style={{ color: ZP.sunInk }} aria-hidden="true" />
        <span className="text-sm font-semibold" style={{ color: ZP.sunInk }}>
          <strong className="font-extrabold">Sign in or create an account</strong> to see your
          pets, upcoming visits and messages, and to start a video visit.
        </span>
      </Link>
    </div>
  );
}
