/**
 * The ZenPaws client app look (light blue, sunny yellow, Nunito), shared by
 * the client portal pages that the iPhone app shows.
 */
export const ZP = {
  surface: "#F2F9FF",
  ink: "#123A5C",
  muted: "#4A6A85",
  accent: "#1B78C2",
  accentDark: "#14507F",
  border: "#D6E8F7",
  chip: "#E3F1FC",
  sky: "#BFE3FB",
  sun: "#FFD35C",
  sunSoft: "#FFF6D9",
  sunInk: "#5C4A12",
  danger: "#9E1C14",
  dangerSoft: "#FDECEA",
} as const;

/** Practice logo, falling back to the bundled ZenPaws app icon. */
export function portalLogo(logoUrl: string | null | undefined): string {
  return logoUrl || "/icon-192.png";
}

export function petInitial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "?";
}
