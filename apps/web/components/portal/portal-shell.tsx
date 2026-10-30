"use client";

import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { CalendarDays, Home, PawPrint, UserRound } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { hexToHslString } from "@/lib/utils";
import { ZP } from "@/lib/portal/zenpaws-theme";
import { SignInCard } from "@/components/portal/sign-in-card";
import {
  GuestPetsPreview,
  GuestVideoPreview,
  GuestVisitsPreview,
} from "@/components/portal/guest-previews";

type PortalThemeStyle = CSSProperties & {
  "--primary"?: string;
  "--ring"?: string;
};

const TABS = [
  { href: "/portal", label: "Home", icon: Home, match: (p: string) => p === "/portal" },
  {
    href: "/portal/appointments",
    label: "Visits",
    icon: CalendarDays,
    match: (p: string) => p.startsWith("/portal/appointments") || p.startsWith("/portal/book") || p.startsWith("/portal/video"),
  },
  { href: "/portal/pets", label: "Pets", icon: PawPrint, match: (p: string) => p.startsWith("/portal/pets") },
  {
    href: "/portal/account",
    label: "Account",
    icon: UserRound,
    match: (p: string) => p.startsWith("/portal/account") || p.startsWith("/portal/messages") || p.startsWith("/portal/invoices"),
  },
] as const;

/**
 * What a visitor without a session sees on each screen: working previews
 * with sample pets for the main tabs, and sign-in/sign-up for the rest.
 */
function guestScreen(pathname: string): ReactNode {
  if (pathname.startsWith("/portal/video")) return <GuestVideoPreview />;
  if (pathname.startsWith("/portal/pets")) return <GuestPetsPreview />;
  if (pathname.startsWith("/portal/book")) {
    return <SignInCard reason="Create a free account to book a house call." initialMode="sign_up" />;
  }
  if (pathname.startsWith("/portal/appointments")) return <GuestVisitsPreview />;
  if (pathname.startsWith("/portal/messages")) {
    return <SignInCard reason="Sign in to message the clinic." />;
  }
  if (pathname.startsWith("/portal/invoices")) {
    return <SignInCard reason="Sign in to see your invoices." />;
  }
  return <SignInCard reason="Sign in, or create a free account." />;
}

/**
 * The client app frame: a phone-width column on the ZenPaws light-blue
 * surface with a bottom tab bar, the same in a browser and in the iPhone app.
 */
export function PortalShell({
  children,
  fontClassName,
}: {
  children: ReactNode;
  fontClassName?: string;
}) {
  const pathname = usePathname();
  const isAccessExchange = pathname.startsWith("/portal/access/");
  const client = trpc.portal.getClient.useQuery(
    {},
    { enabled: !isAccessExchange, retry: false, staleTime: 5 * 60 * 1000 },
  );
  const accent = hexToHslString(ZP.accent);
  const themeStyle: PortalThemeStyle = {
    backgroundColor: ZP.surface,
    color: ZP.ink,
    ...(accent ? { "--primary": accent, "--ring": accent } : {}),
  };
  // Visitors without a session can look around first: the home screen and
  // previews of the other tabs; real actions ask them to sign up.
  const isGuest = !isAccessExchange && client.error?.data?.code === "UNAUTHORIZED";
  const guestGated = isGuest && pathname !== "/portal";
  // The video visit flow is full-screen with its own footer, like the design.
  const showTabs =
    isGuest ||
    (Boolean(client.data) && !isAccessExchange && !pathname.startsWith("/portal/video"));

  return (
    <div className={`min-h-screen ${fontClassName ?? ""}`} style={themeStyle}>
      <main
        id="main-content"
        className={`mx-auto w-full max-w-md px-5 pt-6 ${showTabs ? "pb-28" : "pb-10"}`}
      >
        {guestGated ? guestScreen(pathname) : children}
      </main>
      {showTabs ? (
        <nav
          aria-label="Main"
          className="fixed inset-x-0 bottom-0 z-20 border-t bg-white"
          style={{ borderColor: ZP.border, paddingBottom: "env(safe-area-inset-bottom)" }}
        >
          <div className="mx-auto grid max-w-md grid-cols-4 px-3 pb-3 pt-2">
            {TABS.map((tab) => {
              const active = tab.match(pathname);
              const Icon = tab.icon;
              return (
                <Link
                  key={tab.href}
                  href={tab.href}
                  aria-current={active ? "page" : undefined}
                  className="flex min-h-12 flex-col items-center justify-center gap-0.5 text-[11px] font-extrabold"
                  style={{ color: active ? ZP.accent : ZP.muted }}
                >
                  <Icon className="h-6 w-6" strokeWidth={active ? 2.4 : 2} aria-hidden="true" />
                  {tab.label}
                </Link>
              );
            })}
          </div>
        </nav>
      ) : null}
    </div>
  );
}
