import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { and, eq, isNull } from "drizzle-orm";
import { auditLog, practices, users, visitRecordings } from "@openpims/db";
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

const RECORDING_ROLES = new Set(["admin", "veterinarian", "technician"]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function error(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Receive the audio for a consented visit recording (raw bytes; the
 * Content-Type names the container), store it in the practice's bucket and
 * hand it to Amazon Transcribe. The client then polls visitRecordings.sync.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ recordingId: string }> },
) {
  if (hasBlankConfiguredNextAuthSecret()) return error("Unauthorized", 401);
  const session = await getServerSession(authOptions);
  if (!session?.user) return error("Unauthorized", 401);

  const { recordingId } = await context.params;
  if (!UUID_PATTERN.test(recordingId)) return error("Recording not found", 404);
  if (!visitRecordingTranscriptionConfigured()) {
    return error("Visit recording is not set up on this server.", 409);
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > VISIT_AUDIO_MAX_BYTES) {
    return error("The recording is too large to upload.", 413);
  }
  const contentType = normalizeAudioContentType(
    request.headers.get("content-type"),
  );
  const format = audioFormatForContentType(contentType);
  if (!contentType || !format) {
    return error("Unsupported audio format.", 415);
  }

  const [account] = await withSystem(db, (tx) =>
    tx
      .select({ role: users.role })
      .from(users)
      .innerJoin(
        practices,
        and(eq(practices.id, users.practiceId), isNull(practices.deletedAt)),
      )
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
  if (!RECORDING_ROLES.has(account.role)) return error("Forbidden", 403);

  const limited = await rateLimit({
    key: `visit-audio-upload:user:${session.user.id}`,
    limit: 20,
    windowMs: 60 * 60 * 1000,
  }).catch(() => ({ success: false }));
  if (!limited.success) {
    return error("Too many uploads. Please wait and try again.", 429);
  }

  const body = await readRequestBytesWithLimit(request, VISIT_AUDIO_MAX_BYTES);
  if (!body.ok) return error("The recording is too large to upload.", 413);
  if (!audioBytesMatchFormat(body.bytes, format)) {
    return error("The upload is not a valid audio recording.", 415);
  }

  const practiceId = session.user.practiceId;
  const ipAddress = clientIpFromRequest(request);

  try {
    const outcome = await withTenant(db, practiceId, async (tx) => {
      const [recording] = await tx
        .select({
          id: visitRecordings.id,
          status: visitRecordings.status,
        })
        .from(visitRecordings)
        .where(
          and(
            eq(visitRecordings.id, recordingId),
            eq(visitRecordings.practiceId, practiceId),
            isNull(visitRecordings.deletedAt),
          ),
        )
        .for("update");
      if (!recording) return { kind: "not_found" as const };
      if (recording.status !== "awaiting_audio") {
        return { kind: "conflict" as const };
      }
      if (!(await lockPracticeForExternalSideEffects(tx, practiceId))) {
        return { kind: "hold" as const };
      }

      const key = visitAudioObjectKey({ practiceId, recordingId, format });
      const { versionId } = await putVisitAudio({
        key,
        body: body.bytes,
        contentType,
      });
      const jobName = visitTranscriptionJobName(recordingId);
      try {
        await startVisitTranscription({ jobName, key, format });
      } catch {
        // Nothing will read this audio now, so do not keep it.
        await deleteVisitAudio({ key, versionId }).catch(() => {});
        await tx
          .update(visitRecordings)
          .set({
            status: "failed",
            failureReason: "The transcription service could not be started.",
          })
          .where(eq(visitRecordings.id, recordingId));
        return { kind: "start_failed" as const };
      }

      await tx
        .update(visitRecordings)
        .set({
          status: "transcribing",
          audioObjectKey: key,
          audioObjectVersionId: versionId,
          audioContentType: contentType,
          audioBytes: body.bytes.length,
          transcriptionJobName: jobName,
        })
        .where(eq(visitRecordings.id, recordingId));
      await tx.insert(auditLog).values({
        practiceId,
        userId: session.user.id,
        action: "upload_audio",
        entityType: "visit_recording",
        entityId: recordingId,
        ipAddress,
        changes: { contentType, bytes: body.bytes.length },
      });
      return { kind: "ok" as const };
    });

    switch (outcome.kind) {
      case "ok":
        return NextResponse.json({ status: "transcribing" });
      case "not_found":
        return error("Recording not found", 404);
      case "conflict":
        return error("This recording already has audio.", 409);
      case "hold":
        return error("This practice is on a recovery hold.", 423);
      case "start_failed":
        return error("The transcription service could not be started.", 502);
    }
  } catch {
    return error("Could not save the recording. Try again.", 500);
  }
}
