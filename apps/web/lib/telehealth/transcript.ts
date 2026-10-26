/**
 * Video-visit transcripts: what the client is asked to agree to, the status
 * values a visit's transcript moves through, and turning Daily's WebVTT file
 * into readable "Speaker: words" lines for the clinician's note.
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

/** How long to wait for Daily to save a transcript after the call ends. */
export const TRANSCRIPT_PROCESSING_TIMEOUT_MS = 30 * 60 * 1000;

export const TRANSCRIPT_DISCLOSURE_VERSION = "telehealth-transcript-v1";

export function transcriptDisclosure(input: {
  clinicianName: string | null;
  patientName: string;
  practiceName: string;
}): string {
  const who = input.clinicianName?.trim() || "Your veterinarian";
  return (
    `${who} would like to make a written transcript of this video visit to help write ${input.patientName}'s visit notes. ` +
    `Our video provider converts the conversation to text during the call; the video and audio are not recorded or kept. ` +
    `The transcript is saved to ${input.patientName}'s record at ${input.practiceName}. ` +
    `You can stop the transcript at any time during the call.`
  );
}

export type TranscriptLine = { speaker: string | null; start: number; text: string };

function seconds(stamp: string): number {
  const parts = stamp.trim().split(":").map(Number);
  if (parts.some((value) => Number.isNaN(value))) return 0;
  return parts.reduce((total, value) => total * 60 + value, 0);
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/**
 * Parse a WebVTT transcript. Speakers come from voice tags
 * (`<v Name>words</v>`) or, failing that, a leading "Name:" that matches
 * one of the known participant names. Consecutive cues from the same
 * speaker are joined.
 */
export function parseTranscriptVtt(
  vtt: string,
  knownSpeakers: string[] = [],
): TranscriptLine[] {
  const known = knownSpeakers.map((name) => name.trim()).filter(Boolean);
  const blocks = vtt.replace(/\r\n?/g, "\n").split(/\n{2,}/);
  const lines: TranscriptLine[] = [];
  for (const block of blocks) {
    const rows = block.split("\n");
    const timing = rows.findIndex((row) => row.includes("-->"));
    if (timing < 0) continue;
    const start = seconds(rows[timing]!.split("-->")[0]!);
    let raw = rows.slice(timing + 1).join(" ").trim();
    if (!raw) continue;
    let speaker: string | null = null;
    const voice = /^<v(?:\.[^\s>]+)?\s+([^>]+)>/.exec(raw);
    if (voice) {
      speaker = voice[1]!.trim();
      raw = raw.slice(voice[0].length);
    } else {
      const named = known.find((name) => raw.toLowerCase().startsWith(`${name.toLowerCase()}:`));
      if (named) {
        speaker = named;
        raw = raw.slice(named.length + 1);
      }
    }
    const text = decodeEntities(raw.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
    if (!text) continue;
    const previous = lines[lines.length - 1];
    if (previous && previous.speaker === speaker) {
      previous.text = `${previous.text} ${text}`;
    } else {
      lines.push({ speaker, start, text });
    }
  }
  return lines;
}

export function formatTranscript(lines: TranscriptLine[]): string {
  return lines
    .map((line) => (line.speaker ? `${line.speaker}: ${line.text}` : line.text))
    .join("\n");
}
