import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { and, eq, isNull } from "drizzle-orm";
import { auditLog, practices, telehealthVisits, users } from "@openpims/db";
import { db } from "@openpims/db/client";
import { authOptions } from "@/lib/auth";
import { hasBlankConfiguredNextAuthSecret } from "@/lib/auth-secret";
import { withSystem, withTenant } from "@/lib/tenant-db";
import { readRequestBytesWithLimit } from "@/lib/request-body";
import { clientIpFromRequest } from "@/lib/request-ip";
import { rateLimit } from "@/lib/rate-limit";
import { lockPracticeForExternalSideEffects } from "@/lib/recovery-hold";
import {
  audioBytesMatchFormat,
  audioFormatForContentType,
  normalizeAudioContentType,
  VISIT_AUDIO_MAX_BYTES,
} from "@/lib/visit-recordings/audio";
import {
  deleteVisitAudio,
  putVisitAudio,
  startVisitTranscription,
  visitAudioObjectKey,
  visitRecordingTranscriptionConfigured,
  visitTranscriptionJobName,
} from "@/lib/visit-recordings/aws";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CLINICIAN_ROLES = new Set(["admin", "veterinarian"]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function error(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Receive the call audio the clinician's browser recorded for a consented
 * video-visit transcript (stereo: clinician on the left channel, client on
 * the right), store it in the practice's bucket and hand it to Amazon
 * Transcribe. The visits page then polls telehealth.syncTranscript.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ visitId: string }> },
) {
  if (hasBlankConfiguredNextAuthSecret()) return error("Unauthorized", 401);
  const session = await getServerSession(authOptions);
  if (!session?.user) return error("Unauthorized", 401);

  const { visitId } = await context.params;
  if (!UUID_PATTERN.test(visitId)) return error("Video visit not found", 404);
  if (!visitRecordingTranscriptionConfigured()) {
    return error("Transcription is not set up on this server.", 409);
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > VISIT_AUDIO_MAX_BYTES) {
    return error("The recording is too large to upload.", 413);
  }
  const contentType = normalizeAudioContentType(request.headers.get("content-type"));
  const format = audioFormatForContentType(contentType);
  if (!contentType || !format) return error("Unsupported audio format.", 415);

  const [account] = await withSystem(db, (tx) =>
    tx
      .select({ role: users.role })
      .from(users)
      .innerJoin(practices, and(eq(practices.id, users.practiceId), isNull(practices.deletedAt)))
      .where(
        and(
          eq(users.id, session.user.id),
          eq(users.practiceId, session.user.practiceId),
          isNull(users.deletedAt),
        ),
      )
      .limit(1),
  );
  if (!account) return error("Unauthorized", 401);
  if (!CLINICIAN_ROLES.has(account.role)) return error("Forbidden", 403);

  const limited = await rateLimit({
    key: `telehealth-audio-upload:user:${session.user.id}`,
    limit: 20,
    windowMs: 60 * 60 * 1000,
  }).catch(() => ({ success: false }));
  if (!limited.success) return error("Too many uploads. Please wait and try again.", 429);

  const body = await readRequestBytesWithLimit(request, VISIT_AUDIO_MAX_BYTES);
  if (!body.ok) return error("The recording is too large to upload.", 413);
  if (!audioBytesMatchFormat(body.bytes, format)) {
    return error("The upload is not a valid audio recording.", 415);
  }

  const practiceId = session.user.practiceId;
  const ipAddress = clientIpFromRequest(request);

  try {
    const outcome = await withTenant(db, practiceId, async (tx) => {
      const [visit] = await tx
        .select({ id: telehealthVisits.id, transcriptStatus: telehealthVisits.transcriptStatus })
        .from(telehealthVisits)
        .where(
          and(
            eq(telehealthVisits.id, visitId),
            eq(telehealthVisits.practiceId, practiceId),
            isNull(telehealthVisits.deletedAt),
          ),
        )
        .for("update");
      if (!visit) return { kind: "not_found" as const };
      // Only audio the client agreed to: recorded while the transcript was on.
      if (visit.transcriptStatus !== "active" && visit.transcriptStatus !== "stopped") {
        return { kind: "conflict" as const };
      }
      if (!(await lockPracticeForExternalSideEffects(tx, practiceId))) {
        return { kind: "hold" as const };
      }

      const key = visitAudioObjectKey({ practiceId, recordingId: `telehealth-${visitId}`, format });
      const { versionId } = await putVisitAudio({ key, body: body.bytes, contentType });
      const jobName = visitTranscriptionJobName(`telehealth-${visitId}`);
      try {
        await startVisitTranscription({ jobName, key, format, channelPerSpeaker: true });
      } catch {
        await deleteVisitAudio({ key, versionId }).catch(() => {});
        await tx
          .update(telehealthVisits)
          .set({
            transcriptStatus: "failed",
            transcriptError: "The transcription service could not be started.",
          })
          .where(eq(telehealthVisits.id, visitId));
        return { kind: "start_failed" as const };
      }

      await tx
        .update(telehealthVisits)
        .set({
          transcriptStatus: "processing",
          audioObjectKey: key,
          audioObjectVersionId: versionId,
          transcriptionJobName: jobName,
        })
        .where(eq(telehealthVisits.id, visitId));
      await tx.insert(auditLog).values({
        practiceId,
        userId: session.user.id,
        action: "upload_audio",
        entityType: "telehealth_visit",
        entityId: visitId,
        ipAddress,
        changes: { contentType, bytes: body.bytes.length },
      });
      return { kind: "ok" as const };
    });

    switch (outcome.kind) {
      case "ok":
        return NextResponse.json({ status: "processing" });
      case "not_found":
        return error("Video visit not found", 404);
      case "conflict":
        return error("This visit has no transcript waiting for audio.", 409);
      case "hold":
        return error("This practice is on a recovery hold.", 423);
      case "start_failed":
        return error("The transcription service could not be started.", 502);
    }
  } catch {
    return error("Could not save the recording. Try again.", 500);
  }
}
