import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  DeleteTranscriptionJobCommand,
  GetTranscriptionJobCommand,
  StartTranscriptionJobCommand,
  TranscribeClient,
} from "@aws-sdk/client-transcribe";
import { audioFileExtension, type VisitAudioFormat } from "./audio";

/**
 * Visit audio lives in the practice's own S3 bucket only long enough for
 * Amazon Transcribe to read it. Everything here runs with the server's
 * existing S3 credentials, so the audio never leaves the clinic's AWS account.
 */

const AWS_IO_TIMEOUT_MS = 120_000;
/** Stored transcripts are capped; a long visit is still well under this. */
export const VISIT_TRANSCRIPT_MAX_LENGTH = 200_000;
/** Key prefix so a bucket lifecycle rule can expire any orphaned audio. */
export const VISIT_AUDIO_KEY_PREFIX = "visit-recordings/";

interface VisitRecordingAwsConfig {
  region: string;
  bucket: string;
  credentials: { accessKeyId: string; secretAccessKey: string };
}

function env(name: string): string | undefined {
  const trimmed = process.env[name]?.trim();
  return trimmed ? trimmed : undefined;
}

function awsConfig(): VisitRecordingAwsConfig | null {
  if (env("VISIT_RECORDING_TRANSCRIPTION") !== "aws_transcribe") return null;
  if (env("FILE_STORAGE_PROVIDER") === "vercel_blob") return null;
  // Transcribe reads s3:// URIs, so the files bucket must be real AWS S3.
  const endpoint = env("S3_ENDPOINT");
  if (
    endpoint &&
    !/^https:\/\/s3[.-][a-z0-9.-]*amazonaws\.com\/?$/.test(endpoint)
  ) {
    return null;
  }
  const region = env("VISIT_RECORDING_TRANSCRIBE_REGION") ?? env("S3_REGION");
  const bucket = env("S3_BUCKET");
  const accessKeyId = env("S3_ACCESS_KEY");
  const secretAccessKey = env("S3_SECRET_KEY");
  if (!region || !bucket || !accessKeyId || !secretAccessKey) return null;
  return { region, bucket, credentials: { accessKeyId, secretAccessKey } };
}

/** Whether this server is set up to transcribe visit recordings. */
export function visitRecordingTranscriptionConfigured(): boolean {
  return awsConfig() !== null;
}

export class VisitRecordingNotConfiguredError extends Error {
  constructor() {
    super("Visit recording transcription is not set up on this server.");
    this.name = "VisitRecordingNotConfiguredError";
  }
}

function requireConfig(): VisitRecordingAwsConfig {
  const config = awsConfig();
  if (!config) throw new VisitRecordingNotConfiguredError();
  return config;
}

function s3(config: VisitRecordingAwsConfig): S3Client {
  return new S3Client({
    region: config.region,
    credentials: config.credentials,
    requestHandler: { requestTimeout: AWS_IO_TIMEOUT_MS },
  });
}

function transcribe(config: VisitRecordingAwsConfig): TranscribeClient {
  return new TranscribeClient({
    region: config.region,
    credentials: config.credentials,
    requestHandler: { requestTimeout: AWS_IO_TIMEOUT_MS },
  });
}

export function visitAudioObjectKey(input: {
  practiceId: string;
  recordingId: string;
  format: VisitAudioFormat;
}): string {
  return `${VISIT_AUDIO_KEY_PREFIX}${input.practiceId}/${input.recordingId}.${audioFileExtension(input.format)}`;
}

/** Job names are account-wide and single-use; the timestamp allows a retry. */
export function visitTranscriptionJobName(recordingId: string): string {
  return `openvpm-visit-${recordingId}-${Date.now()}`;
}

export async function putVisitAudio(input: {
  key: string;
  body: Uint8Array;
  contentType: string;
}): Promise<{ versionId: string | null }> {
  const config = requireConfig();
  const result = await s3(config).send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: input.key,
      Body: input.body,
      ContentType: input.contentType,
      ServerSideEncryption: "AES256",
    }),
  );
  return { versionId: result.VersionId ?? null };
}

/**
 * Remove the audio object. On a versioned bucket a plain delete only adds a
 * delete marker, so the stored version is deleted explicitly as well.
 */
export async function deleteVisitAudio(input: {
  key: string;
  versionId: string | null;
}): Promise<void> {
  const config = requireConfig();
  const client = s3(config);
  if (input.versionId) {
    await client.send(
      new DeleteObjectCommand({
        Bucket: config.bucket,
        Key: input.key,
        VersionId: input.versionId,
      }),
    );
    return;
  }
  await client.send(
    new DeleteObjectCommand({ Bucket: config.bucket, Key: input.key }),
  );
}

export async function startVisitTranscription(input: {
  jobName: string;
  key: string;
  format: VisitAudioFormat;
}): Promise<void> {
  const config = requireConfig();
  await transcribe(config).send(
    new StartTranscriptionJobCommand({
      TranscriptionJobName: input.jobName,
      LanguageCode: "en-US",
      MediaFormat: input.format,
      Media: { MediaFileUri: `s3://${config.bucket}/${input.key}` },
      Settings: { ShowSpeakerLabels: true, MaxSpeakerLabels: 4 },
    }),
  );
}

export type VisitTranscriptionPoll =
  | { state: "in_progress" }
  | { state: "completed"; transcript: string }
  | { state: "failed"; reason: string };

export async function pollVisitTranscription(
  jobName: string,
): Promise<VisitTranscriptionPoll> {
  const config = requireConfig();
  const { TranscriptionJob: job } = await transcribe(config).send(
    new GetTranscriptionJobCommand({ TranscriptionJobName: jobName }),
  );
  const status = job?.TranscriptionJobStatus;
  if (status === "FAILED") {
    return {
      state: "failed",
      reason: (job?.FailureReason ?? "Transcription failed.").slice(0, 500),
    };
  }
  if (status !== "COMPLETED") return { state: "in_progress" };

  const uri = job?.Transcript?.TranscriptFileUri;
  if (!uri) return { state: "failed", reason: "Transcript file was missing." };
  const response = await fetch(uri, {
    signal: AbortSignal.timeout(AWS_IO_TIMEOUT_MS),
  });
  if (!response.ok) {
    return {
      state: "failed",
      reason: `Transcript download failed (HTTP ${response.status}).`,
    };
  }
  const transcript = formatTranscribeOutput(await response.json());
  if (!transcript) {
    return { state: "failed", reason: "No speech was found in the recording." };
  }
  return { state: "completed", transcript };
}

/** Drop the job (and with it the service-held transcript copy). */
export async function deleteVisitTranscriptionJob(
  jobName: string,
): Promise<void> {
  const config = requireConfig();
  await transcribe(config).send(
    new DeleteTranscriptionJobCommand({ TranscriptionJobName: jobName }),
  );
}

interface TranscribeItem {
  type?: string;
  speaker_label?: string;
  alternatives?: Array<{ content?: string }>;
}

/**
 * Turn Amazon Transcribe's JSON into "Speaker 1: …" turns. Speaker labels are
 * automatic guesses (spk_0 is whoever spoke first), so the turns are labeled
 * by number rather than by role.
 */
export function formatTranscribeOutput(output: unknown): string {
  const results = (output as { results?: unknown } | null)?.results as
    | { items?: TranscribeItem[]; transcripts?: Array<{ transcript?: string }> }
    | undefined;
  const items = Array.isArray(results?.items) ? results.items : [];
  const hasSpeakers = items.some((item) => item.speaker_label);

  if (!hasSpeakers) {
    const plain = results?.transcripts?.[0]?.transcript?.trim() ?? "";
    return plain.slice(0, VISIT_TRANSCRIPT_MAX_LENGTH);
  }

  const turns: Array<{ speaker: string; text: string }> = [];
  for (const item of items) {
    const content = item.alternatives?.[0]?.content?.trim();
    if (!content) continue;
    const current = turns.at(-1);
    if (item.type === "punctuation") {
      if (current) current.text += content;
      continue;
    }
    const speaker = item.speaker_label ?? current?.speaker ?? "spk_0";
    if (current && current.speaker === speaker) {
      current.text += ` ${content}`;
    } else {
      turns.push({ speaker, text: content });
    }
  }

  const speakerNumbers = new Map<string, number>();
  const lines = turns.map((turn) => {
    if (!speakerNumbers.has(turn.speaker)) {
      speakerNumbers.set(turn.speaker, speakerNumbers.size + 1);
    }
    return `Speaker ${speakerNumbers.get(turn.speaker)}: ${turn.text}`;
  });
  return lines.join("\n").slice(0, VISIT_TRANSCRIPT_MAX_LENGTH);
}
