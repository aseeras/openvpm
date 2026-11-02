import type { TextingAssistantHours } from "./settings";

/** Pure rules for when the texting assistant may reply and what it must say. */

/** The AI disclosure that starts each new conversation. */
export function defaultAssistantIntro(practiceName: string): string {
  return `Hi, this is the ${practiceName.trim() || "clinic"} assistant (AI).`;
}

export const STAFF_TAKEOVER_MS = 12 * 60 * 60 * 1000;
export const HANDOFF_PAUSE_MS = 24 * 60 * 60 * 1000;
export const MAX_REPLIES_PER_DAY = 10;
export const CONVERSATION_GAP_MS = 24 * 60 * 60 * 1000;

const EMERGENCY_PATTERNS = [
  /\bbleed(ing|s)?\b/,
  /\bblood\b/,
  /\bseiz(ure|ures|ing)\b/,
  /\bconvuls/,
  /\bpoison(ed|ing)?\b/,
  /\bate (chocolate|grapes|raisins|xylitol|rat poison|antifreeze)\b/,
  /\b(can'?t|cannot|not|isn'?t) breath(e|ing)\b/,
  /\bstruggling to breathe\b/,
  /\bchoking\b/,
  /\bhit by (a )?car\b/,
  /\bunconscious\b/,
  /\bunresponsive\b/,
  /\bcollaps(e|ed|ing)\b/,
  /\bbloat(ed|ing)?\b/,
  /\bemergency\b/,
  /\bdying\b/,
  /\bhit by\b/,
];

export function looksLikeEmergency(text: string): boolean {
  const normalized = text.toLowerCase().replace(/[’]/g, "'");
  return EMERGENCY_PATTERNS.some((pattern) => pattern.test(normalized));
}

export const EMERGENCY_REPLY =
  "This sounds like it could be an emergency. Please call your nearest 24-hour emergency veterinary hospital right away. We can't handle emergencies by text. We've flagged your message for the team.";

export const AFTER_HOURS_REPLY =
  "Thanks for your message! Our office is closed right now, and the team will reply when we open. If this is an emergency, please call your nearest 24-hour emergency veterinary hospital.";

function minutesOf(time: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

/** Local weekday (0 = Sunday) and minutes past midnight in `timeZone`. */
export function localClock(
  now: Date,
  timeZone: string,
): { day: number; minutes: number; date: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    day: days.indexOf(get("weekday")),
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
    date: `${get("year")}-${get("month")}-${get("day")}`,
  };
}

export function withinOfficeHours(
  now: Date,
  timeZone: string,
  hours: TextingAssistantHours,
): boolean {
  const clock = localClock(now, timeZone);
  if (!hours.days.includes(clock.day)) return false;
  return (
    clock.minutes >= minutesOf(hours.start) &&
    clock.minutes < minutesOf(hours.end)
  );
}

/** Starts the first reply of a conversation with the AI disclosure. */
export function withIntro(
  reply: string,
  firstReply: boolean,
  intro: string,
): string {
  const trimmed = reply.trim();
  const disclosure = intro.trim();
  if (!firstReply || !disclosure || trimmed.startsWith(disclosure)) {
    return trimmed;
  }
  return `${disclosure} ${trimmed}`;
}
