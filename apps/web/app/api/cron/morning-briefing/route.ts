import { NextResponse } from "next/server";
import { db } from "@openpims/db/client";
import { alertOps } from "@/lib/alerts";
import { cronAuthError } from "@/lib/cron-auth";
import { reportCronHeartbeat } from "@/lib/cron-heartbeat";
import { runMorningBriefings } from "@/lib/agent/morning-briefing";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Hourly: emails each opted-in clinician their morning briefing once per
 * local day, at or shortly after the practice's chosen hour.
 */
export async function GET(request: Request) {
  const authError = cronAuthError(request);
  if (authError) return authError;

  try {
    const result = await runMorningBriefings(db);
    await reportCronHeartbeat({
      job: "morning-briefing",
      status: result.failed > 0 ? "degraded" : "ok",
      detail: `${result.sent} sent, ${result.skipped} skipped, ${result.failed} failed`,
      metrics: result,
    });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void alertOps("Morning briefing failed", message);
    await reportCronHeartbeat({
      job: "morning-briefing",
      status: "failed",
      detail: message,
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
