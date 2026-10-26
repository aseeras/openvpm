/**
 * Audio formats a phone browser's MediaRecorder produces (Safari: mp4/AAC,
 * Chrome and Android: webm/Opus) plus the two common file formats, mapped to
 * the media format names Amazon Transcribe accepts.
 */
export type VisitAudioFormat = "mp4" | "webm" | "ogg" | "wav";

const CONTENT_TYPE_FORMATS: Record<string, VisitAudioFormat> = {
  "audio/mp4": "mp4",
  "audio/x-m4a": "mp4",
  "audio/m4a": "mp4",
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
};

/** 64 MiB: about an hour of phone-recorded AAC, several hours of Opus. */
export const VISIT_AUDIO_MAX_BYTES = 64 * 1024 * 1024;

/** Strip codec parameters ("audio/webm;codecs=opus" → "audio/webm"). */
export function normalizeAudioContentType(value: string | null): string | null {
  const base = value?.split(";")[0]?.trim().toLowerCase();
  return base ? base : null;
}

export function audioFormatForContentType(
  value: string | null,
): VisitAudioFormat | null {
  const normalized = normalizeAudioContentType(value);
  return normalized ? (CONTENT_TYPE_FORMATS[normalized] ?? null) : null;
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

/** Check the container signature so a mislabeled upload is refused. */
export function audioBytesMatchFormat(
  bytes: Uint8Array,
  format: VisitAudioFormat,
): boolean {
  if (bytes.length < 12) return false;
  switch (format) {
    case "mp4":
      return ascii(bytes, 4, 4) === "ftyp";
    case "webm":
      return (
        bytes[0] === 0x1a &&
        bytes[1] === 0x45 &&
        bytes[2] === 0xdf &&
        bytes[3] === 0xa3
      );
    case "ogg":
      return ascii(bytes, 0, 4) === "OggS";
    case "wav":
      return ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE";
  }
}

export function audioFileExtension(format: VisitAudioFormat): string {
  return format === "mp4" ? "m4a" : format;
}
