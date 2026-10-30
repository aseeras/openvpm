import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function appIds(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => /^[A-Z0-9]{10}\.[A-Za-z0-9.-]+$/.test(value));
}

/**
 * Apple app-site association for a clinic's own iPhone apps, each listed as
 * "TEAMID.bundle.id" (comma-separated for several):
 * - APPLE_APP_LINK_APP_IDS: portal links such as one-time sign-in links open
 *   in that app instead of Safari.
 * - APPLE_WEB_CREDENTIAL_APP_IDS: iOS offers passwords saved for this site
 *   inside those apps (for example a staff app that loads the system).
 * Unset, nothing is published.
 */
export function GET() {
  const linkApps = appIds("APPLE_APP_LINK_APP_IDS");
  const credentialApps = appIds("APPLE_WEB_CREDENTIAL_APP_IDS");
  if (linkApps.length === 0 && credentialApps.length === 0) {
    return new NextResponse(null, { status: 404 });
  }
  return NextResponse.json(
    {
      ...(linkApps.length > 0
        ? {
            applinks: {
              details: [
                {
                  appIDs: linkApps,
                  components: [{ "/": "/portal/*", comment: "Client portal" }],
                },
              ],
            },
          }
        : {}),
      ...(credentialApps.length > 0 ? { webcredentials: { apps: credentialApps } } : {}),
    },
    { headers: { "Cache-Control": "public, max-age=3600" } },
  );
}
