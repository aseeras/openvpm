import { randomBytes } from "node:crypto";

/**
 * Video rooms for telehealth visits, hosted by Daily (daily.co). Each visit
 * gets its own private room that only people holding a meeting token can
 * enter; tokens and rooms expire on their own, and the room is deleted when
 * the clinician ends the visit. Calls are never recorded.
 */

/** Overridable only so tests can point at a local stand-in. */
function dailyApi(): string {
  return env("DAILY_API_URL") ?? "https://api.daily.co/v1";
}
const DAILY_TIMEOUT_MS = 15_000;
/** Longest a single video visit room stays open. */
export const TELEHEALTH_ROOM_TTL_SECONDS = 2 * 60 * 60;

function env(name: string): string | undefined {
  const trimmed = process.env[name]?.trim();
  return trimmed ? trimmed : undefined;
}

/** The Daily subdomain, e.g. "zenpaws" for zenpaws.daily.co. */
export function dailyDomain(): string | null {
  const domain = env("DAILY_DOMAIN")?.toLowerCase();
  return domain && /^[a-z0-9-]{1,63}$/.test(domain) ? domain : null;
}

export function dailyOrigin(): string | null {
  const domain = dailyDomain();
  return domain ? `https://${domain}.daily.co` : null;
}

export function telehealthVideoConfigured(): boolean {
  return Boolean(env("DAILY_API_KEY") && dailyDomain());
}

export class TelehealthVideoUnavailableError extends Error {
  constructor(message = "Video visits are not set up on this server.") {
    super(message);
    this.name = "TelehealthVideoUnavailableError";
  }
}

async function daily<T>(
  path: string,
  init: { method: "GET" | "POST" | "DELETE"; body?: unknown },
): Promise<T | null> {
  const key = env("DAILY_API_KEY");
  if (!key || !dailyDomain()) throw new TelehealthVideoUnavailableError();
  const response = await fetch(`${dailyApi()}${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(DAILY_TIMEOUT_MS),
  });
  if (init.method === "DELETE" && response.status === 404) return null;
  if (!response.ok) {
    throw new TelehealthVideoUnavailableError(
      `The video service returned an error (HTTP ${response.status}).`,
    );
  }
  return (await response.json()) as T;
}

/** Create a private, short-lived room for one visit. */
export async function createVisitRoom(): Promise<{ name: string }> {
  const name = `visit-${randomBytes(12).toString("hex")}`;
  const exp = Math.floor(Date.now() / 1000) + TELEHEALTH_ROOM_TTL_SECONDS;
  const room = await daily<{ name: string }>("/rooms", {
    method: "POST",
    body: {
      name,
      privacy: "private",
      properties: {
        exp,
        eject_at_room_exp: true,
        max_participants: 4,
        enable_prejoin_ui: true,
        enable_chat: true,
        enable_screenshare: false,
        enable_knocking: false,
        // Only used when the client agrees to a transcript of the visit.
        enable_transcription_storage: true,
        lang: "en",
      },
    },
  });
  return { name: room?.name ?? name };
}

/** A pass into one room for one person; expires with the room. */
export async function createJoinUrl(input: {
  roomName: string;
  userName: string;
  isClinician: boolean;
}): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + TELEHEALTH_ROOM_TTL_SECONDS;
  const result = await daily<{ token: string }>("/meeting-tokens", {
    method: "POST",
    body: {
      properties: {
        room_name: input.roomName,
        user_name: input.userName.slice(0, 60),
        is_owner: input.isClinician,
        exp,
        eject_at_token_exp: true,
      },
    },
  });
  if (!result?.token) throw new TelehealthVideoUnavailableError();
  return `${dailyOrigin()}/${encodeURIComponent(input.roomName)}?t=${encodeURIComponent(result.token)}`;
}

/** Close the room so nobody can rejoin a finished visit. */
export async function deleteVisitRoom(roomName: string): Promise<void> {
  await daily(`/rooms/${encodeURIComponent(roomName)}`, { method: "DELETE" });
}

/**
 * Transcripts (text only, never audio or video) for visits where the client
 * agreed. Daily transcribes the call as it happens and saves a WebVTT file
 * labelled by each person's name; we copy it into the visit and delete
 * Daily's copy.
 */
export async function startTranscription(roomName: string): Promise<void> {
  await daily(`/rooms/${encodeURIComponent(roomName)}/transcription/start`, {
    method: "POST",
    body: { language: "en", punctuate: true },
  });
}

export async function stopTranscription(roomName: string): Promise<void> {
  await daily(`/rooms/${encodeURIComponent(roomName)}/transcription/stop`, {
    method: "POST",
    body: {},
  });
}

export type DailyTranscriptInfo = {
  transcriptId: string;
  status: string;
  isVttAvailable: boolean;
  createdAt: string;
};

/** The newest transcript Daily holds for a room, if any. */
export async function latestTranscript(
  roomName: string,
): Promise<DailyTranscriptInfo | null> {
  const result = await daily<{
    data?: Array<{
      transcriptId?: string;
      status?: string;
      isVttAvailable?: boolean;
      created_at?: string;
    }>;
  }>(`/transcript?room_name=${encodeURIComponent(roomName)}&limit=10`, {
    method: "GET",
  });
  const rows = (result?.data ?? [])
    .filter((row) => typeof row.transcriptId === "string")
    .map((row) => ({
      transcriptId: row.transcriptId as string,
      status: row.status ?? "",
      isVttAvailable: row.isVttAvailable === true,
      createdAt: row.created_at ?? "",
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return rows[0] ?? null;
}

const TRANSCRIPT_MAX_BYTES = 2 * 1024 * 1024;

export async function downloadTranscript(transcriptId: string): Promise<string> {
  const result = await daily<{ link?: string; download_link?: string }>(
    `/transcript/${encodeURIComponent(transcriptId)}/access-link`,
    { method: "GET" },
  );
  const link = result?.link ?? result?.download_link;
  if (!link || !/^https:\/\//.test(link)) {
    throw new TelehealthVideoUnavailableError("The transcript is not ready yet.");
  }
  const response = await fetch(link, { signal: AbortSignal.timeout(DAILY_TIMEOUT_MS) });
  if (!response.ok) {
    throw new TelehealthVideoUnavailableError(
      `Could not download the transcript (HTTP ${response.status}).`,
    );
  }
  const text = await response.text();
  if (text.length > TRANSCRIPT_MAX_BYTES) {
    throw new TelehealthVideoUnavailableError("The transcript is too large.");
  }
  return text;
}

export async function deleteTranscript(transcriptId: string): Promise<void> {
  await daily(`/transcript/${encodeURIComponent(transcriptId)}`, {
    method: "DELETE",
  });
}
