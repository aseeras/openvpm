import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Pre-visit check-in",
  description: "Tell your veterinarian about your pet before the visit",
  referrer: "no-referrer",
  robots: { index: false, follow: false, nocache: true },
};

export default function CheckInLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="min-h-screen bg-gray-50">{children}</div>;
}
