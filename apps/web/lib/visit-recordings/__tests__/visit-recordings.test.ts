import { afterEach, describe, expect, it, vi } from "vitest";
import { audioBytesMatchFormat, audioFormatForContentType } from "../audio";
import {
  formatTranscribeOutput,
  visitAudioObjectKey,
  visitRecordingTranscriptionConfigured,
  VISIT_AUDIO_KEY_PREFIX,
} from "../aws";
import { consentIsActive } from "../consent";
import { VISIT_RECORDING_CONSENT_TTL_MS } from "../disclosure";

const NOW = Date.parse("2026-10-25T15:00:00Z");

describe("consentIsActive", () => {
  it("allows recording right after the client agrees", () => {
    expect(
      consentIsActive(
        { action: "granted", occurredAt: new Date(NOW - 1000) },
        NOW,
      ),
    ).toBe(true);
  });

  it("tolerates small clock differences between database and server", () => {
    expect(
      consentIsActive(
        { action: "granted", occurredAt: new Date(NOW + 2000) },
        NOW,
      ),
    ).toBe(true);
  });

  it("blocks recording when the latest answer is no", () => {
    expect(
      consentIsActive({ action: "declined", occurredAt: new Date(NOW) }, NOW),
    ).toBe(false);
  });

  it("blocks recording with no answer at all", () => {
    expect(consentIsActive(null, NOW)).toBe(false);
  });

  it("expires a yes after the consent window", () => {
    expect(
      consentIsActive(
        {
          action: "granted",
          occurredAt: new Date(NOW - VISIT_RECORDING_CONSENT_TTL_MS - 1),
        },
        NOW,
      ),
    ).toBe(false);
  });
});

describe("audio format checks", () => {
  const mp4 = new Uint8Array([
    0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20,
  ]);
  const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]);

  it("maps recorder content types, ignoring codec parameters", () => {
    expect(audioFormatForContentType("audio/mp4")).toBe("mp4");
    expect(audioFormatForContentType("audio/webm;codecs=opus")).toBe("webm");
    expect(audioFormatForContentType("image/png")).toBeNull();
    expect(audioFormatForContentType(null)).toBeNull();
  });

  it("refuses bytes that do not match the declared container", () => {
    expect(audioBytesMatchFormat(mp4, "mp4")).toBe(true);
    expect(audioBytesMatchFormat(webm, "webm")).toBe(true);
    expect(audioBytesMatchFormat(webm, "mp4")).toBe(false);
    expect(audioBytesMatchFormat(new Uint8Array(4), "mp4")).toBe(false);
  });
});

describe("audio object keys", () => {
  it("keeps audio under one prefix so a lifecycle rule can expire orphans", () => {
    const key = visitAudioObjectKey({
      practiceId: "11111111-1111-4111-8111-111111111111",
      recordingId: "22222222-2222-4222-8222-222222222222",
      format: "mp4",
    });
    expect(key.startsWith(VISIT_AUDIO_KEY_PREFIX)).toBe(true);
    expect(key.endsWith(".m4a")).toBe(true);
  });
});

describe("visitRecordingTranscriptionConfigured", () => {
  afterEach(() => vi.unstubAllEnvs());

  function stubAws() {
    vi.stubEnv("VISIT_RECORDING_TRANSCRIPTION", "aws_transcribe");
    vi.stubEnv("FILE_STORAGE_PROVIDER", "s3");
    vi.stubEnv("S3_ENDPOINT", "https://s3.us-east-2.amazonaws.com");
    vi.stubEnv("S3_REGION", "us-east-2");
    vi.stubEnv("S3_BUCKET", "clinic-files");
    vi.stubEnv("S3_ACCESS_KEY", "key");
    vi.stubEnv("S3_SECRET_KEY", "secret");
  }

  it("is on only when explicitly enabled with AWS S3 credentials", () => {
    stubAws();
    expect(visitRecordingTranscriptionConfigured()).toBe(true);
    vi.stubEnv("VISIT_RECORDING_TRANSCRIPTION", "");
    expect(visitRecordingTranscriptionConfigured()).toBe(false);
  });

  it("stays off for non-AWS object storage that Transcribe cannot read", () => {
    stubAws();
    vi.stubEnv("S3_ENDPOINT", "http://minio:9000");
    expect(visitRecordingTranscriptionConfigured()).toBe(false);
  });
});

describe("formatTranscribeOutput", () => {
  it("groups words into numbered speaker turns", () => {
    const output = {
      results: {
        items: [
          {
            type: "pronunciation",
            speaker_label: "spk_1",
            alternatives: [{ content: "He" }],
          },
          {
            type: "pronunciation",
            speaker_label: "spk_1",
            alternatives: [{ content: "limps" }],
          },
          { type: "punctuation", alternatives: [{ content: "." }] },
          {
            type: "pronunciation",
            speaker_label: "spk_0",
            alternatives: [{ content: "Hips" }],
          },
          {
            type: "pronunciation",
            speaker_label: "spk_0",
            alternatives: [{ content: "feel" }],
          },
          {
            type: "pronunciation",
            speaker_label: "spk_0",
            alternatives: [{ content: "stiff" }],
          },
          { type: "punctuation", alternatives: [{ content: "." }] },
        ],
      },
    };
    expect(formatTranscribeOutput(output)).toBe(
      "Speaker 1: He limps.\nSpeaker 2: Hips feel stiff.",
    );
  });

  it("falls back to the plain transcript without speaker labels", () => {
    expect(
      formatTranscribeOutput({
        results: { items: [], transcripts: [{ transcript: " Hello there. " }] },
      }),
    ).toBe("Hello there.");
  });

  it("returns an empty string for silence or malformed output", () => {
    expect(formatTranscribeOutput({ results: { items: [] } })).toBe("");
    expect(formatTranscribeOutput(null)).toBe("");
  });
});
