import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The ZenPaws fork shows the client portal as the ZenPaws app: one shell with
// a bottom tab bar on the ZenPaws light-blue palette, practice logo first.
describe("portal branding UI", () => {
  const shell = readFileSync("components/portal/portal-shell.tsx", "utf8");
  const layout = readFileSync("app/portal/layout.tsx", "utf8");
  const home = readFileSync("app/portal/[token]/page.tsx", "utf8");
  const theme = readFileSync("lib/portal/zenpaws-theme.ts", "utf8");
  const portalPages = [
    "app/portal/[token]/page.tsx",
    "app/portal/[token]/book/page.tsx",
    "app/portal/[token]/appointments/page.tsx",
    "app/portal/[token]/messages/page.tsx",
    "app/portal/[token]/invoices/page.tsx",
    "app/portal/[token]/pets/[petId]/page.tsx",
    "app/portal/[token]/pets/page.tsx",
    "app/portal/[token]/account/page.tsx",
    "app/portal/[token]/video/page.tsx",
  ].map((path) => readFileSync(path, "utf8"));

  it("uses one app shell with a tab bar across every client portal route", () => {
    expect(layout).toContain("<PortalShell fontClassName={nunito.className}>");
    expect(shell).toContain("trpc.portal.getClient.useQuery");
    expect(shell).toContain('aria-label="Main"');
    for (const tab of ['"/portal"', '"/portal/appointments"', '"/portal/pets"', '"/portal/account"']) {
      expect(shell).toContain(tab);
    }
  });

  it("keeps safe fallbacks for unbranded practices and expired sessions", () => {
    expect(theme).toContain('logoUrl || "/icon-192.png"');
    expect(shell).toContain("retry: false");
    expect(home).toContain("if (error || !data)");
  });

  it("scopes the accent variables to the portal shell", () => {
    expect(shell).toContain('"--primary": accent');
    expect(shell).toContain('"--ring": accent');
    for (const page of portalPages) {
      expect(page).not.toMatch(/(?:bg|text|border|ring)-teal-/);
    }
  });

  it("retains accessible structure and logo alternatives", () => {
    expect(shell).toContain('id="main-content"');
    expect(shell).toContain('aria-current={active ? "page" : undefined}');
    expect(home).toContain("alt={`${data.practice.name} logo`}");
  });
});
