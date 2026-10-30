/**
 * Video-visit transcripts: what the client is asked to agree to and the
 * status values a visit's transcript moves through.
 *
 * off → requested → active (the clinician's browser records the call) →
 * stopped (recording ended, upload pending) → processing (Amazon
 * Transcribe) → ready | failed. The client may also decline.
 */

export const TRANSCRIPT_STATUSES = [
  "off",
  "requested",
  "declined",
  "active",
  "stopped",
  "processing",
  "ready",
  "failed",
] as const;
export type TranscriptStatus = (typeof TRANSCRIPT_STATUSES)[number];

/** How long a stopped recording may wait for its upload after the call. */
export const TRANSCRIPT_UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;

export const TRANSCRIPT_DISCLOSURE_VERSION = "telehealth-transcript-v2";

export function transcriptDisclosure(input: {
  clinicianName: string | null;
  patientName: string;
  practiceName: string;
}): string {
  const who = input.clinicianName?.trim() || "Your veterinarian";
  return (
    `${who} would like to make a written transcript of this video visit to help write ${input.patientName}'s visit notes. ` +
    `${who}'s computer records the call audio (not video) to create the transcript; the audio is deleted as soon as the transcript is made. ` +
    `The transcript is saved to ${input.patientName}'s record at ${input.practiceName}. ` +
    `You can stop the transcript at any time during the call.`
  );
}
