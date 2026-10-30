import type { Metadata } from "next";
import { Nunito } from "next/font/google";
import { PortalShell } from "@/components/portal/portal-shell";

const nunito = Nunito({
  subsets: ["latin"],
  weight: ["400", "600", "700", "800", "900"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "ZenPaws",
  description: "Your pets, visits and video rechecks with ZenPaws",
  referrer: "no-referrer",
  robots: { index: false, follow: false, nocache: true },
};

export default function PortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <PortalShell fontClassName={nunito.className}>{children}</PortalShell>;
}
