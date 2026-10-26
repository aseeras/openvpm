import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Apple app-site association for a clinic's own iPhone app. Set
 * APPLE_APP_LINK_APP_IDS to "TEAMID.bundle.id" (comma-separated for several)
 * and portal links such as one-time sign-in links open in that app instead
 * of Safari. Unset, nothing is published.
 */
export function GET() {
  const appIds = (process.env.APPLE_APP_LINK_APP_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => /^[A-Z0-9]{10}\.[A-Za-z0-9.-]+$/.test(value));
  if (appIds.length === 0) {
    return new NextResponse(null, { status: 404 });
  }
  return NextResponse.json(
    {
      applinks: {
        details: [
          {
            appIDs: appIds,
            components: [{ "/": "/portal/*", comment: "Client portal" }],
          },
        ],
      },
    },
    { headers: { "Cache-Control": "public, max-age=3600" } },
  );
}
