/**
 * Per-practice settings for the texting assistant, stored under
 * `practices.settings.textingAssistant`. Everything defaults to off so a
 * practice must opt in explicitly.
 */

export type TextingAssistantMode = "off" | "draft" | "live";

export interface TextingAssistantHours {
  /** 0 = Sunday … 6 = Saturday, in the practice time zone. */
  days: number[];
  /** "HH:MM", 24-hour clock, practice time zone. */
  start: string;
  end: string;
}

export interface TextingAssistantSettings {
  mode: TextingAssistantMode;
  /** Facts the assistant may share: services, area, how visits work. */
  info: string;
  hours: TextingAssistantHours;
  /** First-reply AI disclosure; blank uses "Hi, this is the <practice> assistant (AI)." */
  intro: string;
  /** Whether the assistant may share prices that appear in `info`. */
  sharePrices: boolean;
}

export const TEXTING_ASSISTANT_INTRO_MAX_LENGTH = 200;

export const TEXTING_ASSISTANT_INFO_MAX_LENGTH = 6000;

export const DEFAULT_TEXTING_ASSISTANT_HOURS: TextingAssistantHours = {
  days: [1, 2, 3, 4, 5],
  start: "08:00",
  end: "18:00",
};

export const DEFAULT_TEXTING_ASSISTANT_SETTINGS: TextingAssistantSettings = {
  mode: "off",
  info: "",
  hours: DEFAULT_TEXTING_ASSISTANT_HOURS,
  intro: "",
  sharePrices: false,
};

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function parseHours(raw: unknown): TextingAssistantHours {
  if (!raw || typeof raw !== "object") return DEFAULT_TEXTING_ASSISTANT_HOURS;
  const value = raw as Record<string, unknown>;
  const days = Array.isArray(value.days)
    ? [
        ...new Set(
          value.days.filter(
            (day): day is number =>
              Number.isInteger(day) &&
              (day as number) >= 0 &&
              (day as number) <= 6,
          ),
        ),
      ].sort()
    : DEFAULT_TEXTING_ASSISTANT_HOURS.days;
  const start =
    typeof value.start === "string" && TIME_PATTERN.test(value.start)
      ? value.start
      : DEFAULT_TEXTING_ASSISTANT_HOURS.start;
  const end =
    typeof value.end === "string" && TIME_PATTERN.test(value.end)
      ? value.end
      : DEFAULT_TEXTING_ASSISTANT_HOURS.end;
  return { days, start, end };
}

export function textingAssistantSettingsFrom(
  practiceSettings: unknown,
): TextingAssistantSettings {
  if (!practiceSettings || typeof practiceSettings !== "object") {
    return DEFAULT_TEXTING_ASSISTANT_SETTINGS;
  }
  const raw = (practiceSettings as Record<string, unknown>).textingAssistant;
  if (!raw || typeof raw !== "object")
    return DEFAULT_TEXTING_ASSISTANT_SETTINGS;
  const value = raw as Record<string, unknown>;
  const mode: TextingAssistantMode =
    value.mode === "draft" || value.mode === "live" ? value.mode : "off";
  const info =
    typeof value.info === "string"
      ? value.info.slice(0, TEXTING_ASSISTANT_INFO_MAX_LENGTH)
      : "";
  const intro =
    typeof value.intro === "string"
      ? value.intro.trim().slice(0, TEXTING_ASSISTANT_INTRO_MAX_LENGTH)
      : "";
  return {
    mode,
    info,
    hours: parseHours(value.hours),
    intro,
    sharePrices: value.sharePrices === true,
  };
}
