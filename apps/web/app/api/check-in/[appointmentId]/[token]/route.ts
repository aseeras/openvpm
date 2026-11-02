import { NextRequest, NextResponse } from "next/server";
import { db, type Database } from "@openpims/db/client";
import { appointments } from "@openpims/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { withSystem, withTenant } from "@/lib/tenant-db";
import { rateLimit, rateLimitResponseHeaders } from "@/lib/rate-limit";
import { clientIpFromRequest } from "@/lib/request-ip";
import { readRequestBytesWithLimit } from "@/lib/request-body";
import { checkInAnswersInput } from "@/lib/check-in/form";
import { checkInRateLimitKey, verifyCheckInToken } from "@/lib/check-in/link";
import {
  CheckInClosedError,
  CheckInIncompleteError,
  loadCheckInVisit,
  saveCheckIn,
  type CheckInVisit,
} from "@/lib/check-in/store";
import { sanitizedExceptionTelemetry } from "@/lib/sanitized-exception-telemetry";

export const dynamic = "force-dynamic";

/**
 * No-login pre-appointment check-in form behind the link sent with a booking
 * (see lib/check-in/link.ts). Every miss — bad shape, bad signature, unknown
 * or deleted visit — is the same generic 404.
 */

const TOKEN_LIMIT = 60;
const TOKEN_WINDOW_MS = 10 * 60 * 1000;
const IP_LIMIT = 60;
const IP_WINDOW_MS = 10 * 60 * 1000;
const REQUEST_MAX_BYTES = 64_000;

const submitInput = z.object({ answers: checkInAnswersInput });

type Params = { params: Promise<{ appointmentId: string; token: string }> };

function json(body: unknown, init?: ResponseInit): NextResponse {
  const response = NextResponse.json(body, init);
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  return response;
}

function notFound(): NextResponse {
  return json({ error: "Not found" }, { status: 404 });
}

async function enforceRateLimits(
  request: NextRequest,
  token: string,
  scope: string,
): Promise<NextResponse | null> {
  const ipResult = await rateLimit({
    key: `${scope}:ip:${clientIpFromRequest(request)}`,
    limit: IP_LIMIT,
    windowMs: IP_WINDOW_MS,
  });
  if (!ipResult.success) {
    return json(
      { error: "Too many requests" },
      { status: 429, headers: rateLimitResponseHeaders(IP_LIMIT, ipResult) },
    );
  }
  const tokenResult = await rateLimit({
    key: checkInRateLimitKey(scope, token),
    limit: TOKEN_LIMIT,
    windowMs: TOKEN_WINDOW_MS,
  });
  return tokenResult.success
    ? null
    : json(
        { error: "Too many requests" },
        {
          status: 429,
          headers: rateLimitResponseHeaders(TOKEN_LIMIT, tokenResult),
        },
      );
}

async function practiceIdForAppointment(
  appointmentId: string,
): Promise<string | null> {
  const [row] = await withSystem(db, (tx) =>
    tx
      .select({ practiceId: appointments.practiceId })
      .from(appointments)
      .where(eq(appointments.id, appointmentId))
      .limit(1),
  );
  return row?.practiceId ?? null;
}

function publicVisit(visit: CheckInVisit) {
  return {
    patientName: visit.patientName,
    patientSpecies: visit.patientSpecies,
    clientFirstName: visit.clientFirstName,
    practiceName: visit.practiceName,
    practiceTimezone: visit.practiceTimezone,
    visitTypeName: visit.visitTypeName,
    startTime: visit.startTime.toISOString(),
    open: visit.open,
    submittedAt: visit.submittedAt?.toISOString() ?? null,
    answers: visit.answers,
  };
}

export async function GET(request: NextRequest, { params }: Params) {
  const { appointmentId, token } = await params;
  if (!verifyCheckInToken(appointmentId, token)) return notFound();
  const limited = await enforceRateLimits(request, token, "check-in-read");
  if (limited) return limited;

  try {
    const practiceId = await practiceIdForAppointment(appointmentId);
    if (!practiceId) return notFound();
    const visit = await withTenant(db, practiceId, (tx) =>
      loadCheckInVisit(tx, appointmentId),
    );
    if (!visit) return notFound();
    return json(publicVisit(visit));
  } catch (error) {
    console.error("[check-in] load failed", sanitizedExceptionTelemetry(error));
    return json({ error: "Something went wrong" }, { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: Params) {
  const { appointmentId, token } = await params;
  if (!verifyCheckInToken(appointmentId, token)) return notFound();
  const limited = await enforceRateLimits(request, token, "check-in-submit");
  if (limited) return limited;

  const body = await readRequestBytesWithLimit(request, REQUEST_MAX_BYTES);
  if (!body.ok) return json({ error: "Too large" }, { status: 413 });
  let parsed: z.infer<typeof submitInput>;
  try {
    const result = submitInput.safeParse(
      JSON.parse(new TextDecoder().decode(body.bytes)),
    );
    if (!result.success) {
      return json({ error: "Some answers are not valid." }, { status: 400 });
    }
    parsed = result.data;
  } catch {
    return json({ error: "Invalid request" }, { status: 400 });
  }

  try {
    const practiceId = await practiceIdForAppointment(appointmentId);
    if (!practiceId) return notFound();
    const effects: Array<(rootDb: Database) => Promise<void>> = [];
    const result = await withTenant(db, practiceId, async (tx) => {
      const visit = await loadCheckInVisit(tx, appointmentId);
      if (!visit) return null;
      return saveCheckIn(
        { db: tx, postCommitEffect: (effect) => effects.push(effect) },
        visit,
        parsed.answers,
        "link",
      );
    });
    if (!result) return notFound();
    for (const effect of effects) {
      await effect(db).catch(() => undefined);
    }
    return json({ ok: true, submittedAt: result.submittedAt.toISOString() });
  } catch (error) {
    if (error instanceof CheckInClosedError) {
      return json({ error: error.message }, { status: 409 });
    }
    if (error instanceof CheckInIncompleteError) {
      return json({ error: error.message }, { status: 400 });
    }
    console.error("[check-in] save failed", sanitizedExceptionTelemetry(error));
    return json({ error: "Something went wrong" }, { status: 500 });
  }
}
