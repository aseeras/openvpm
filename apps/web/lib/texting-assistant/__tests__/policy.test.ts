import { describe, expect, it } from "vitest";
import {
  AFTER_HOURS_REPLY,
  defaultAssistantIntro,
  localClock,
  looksLikeEmergency,
  withinOfficeHours,
  withIntro,
} from "../policy";
import {
  DEFAULT_TEXTING_ASSISTANT_SETTINGS,
  textingAssistantSettingsFrom,
} from "../settings";

const hours = { days: [1, 2, 3, 4, 5], start: "08:00", end: "18:00" };
const tz = "America/New_York";

describe("texting assistant policy", () => {
  it("spots likely emergencies", () => {
    expect(looksLikeEmergency("My dog is having a seizure")).toBe(true);
    expect(looksLikeEmergency("she can’t breathe")).toBe(true);
    expect(looksLikeEmergency("Milo ate chocolate")).toBe(true);
    expect(looksLikeEmergency("Can we book a follow up next week?")).toBe(
      false,
    );
  });

  it("checks office hours in the clinic's time zone", () => {
    // Monday 2026-11-02 14:00 UTC = 9:00 Eastern
    expect(withinOfficeHours(new Date("2026-11-02T14:00:00Z"), tz, hours)).toBe(
      true,
    );
    // Monday 23:30 UTC = 18:30 Eastern
    expect(withinOfficeHours(new Date("2026-11-02T23:30:00Z"), tz, hours)).toBe(
      false,
    );
    // Sunday
    expect(withinOfficeHours(new Date("2026-11-01T16:00:00Z"), tz, hours)).toBe(
      false,
    );
    expect(localClock(new Date("2026-11-02T14:00:00Z"), tz)).toEqual({
      day: 1,
      minutes: 9 * 60,
      date: "2026-11-02",
    });
  });

  it("adds the AI introduction only to the first reply", () => {
    const intro = defaultAssistantIntro("Happy Paws");
    expect(intro).toBe("Hi, this is the Happy Paws assistant (AI).");
    expect(withIntro("Sure!", true, intro)).toBe(`${intro} Sure!`);
    expect(withIntro("Sure!", false, intro)).toBe("Sure!");
    expect(withIntro(`${intro} Sure!`, true, intro)).toBe(`${intro} Sure!`);
    expect(
      withIntro(AFTER_HOURS_REPLY, true, intro).endsWith(AFTER_HOURS_REPLY),
    ).toBe(true);
  });
});

describe("texting assistant settings", () => {
  it("defaults to off", () => {
    expect(textingAssistantSettingsFrom(null)).toEqual(
      DEFAULT_TEXTING_ASSISTANT_SETTINGS,
    );
    expect(
      textingAssistantSettingsFrom({ textingAssistant: { mode: "bogus" } })
        .mode,
    ).toBe("off");
  });

  it("reads saved settings and drops bad values", () => {
    const settings = textingAssistantSettingsFrom({
      textingAssistant: {
        mode: "draft",
        info: "We do house calls.",
        intro: "  Hi, this is the clinic assistant (AI).  ",
        sharePrices: "yes",
        hours: { days: [6, 1, 9, 1], start: "09:00", end: "25:00" },
      },
    });
    expect(settings).toEqual({
      mode: "draft",
      info: "We do house calls.",
      intro: "Hi, this is the clinic assistant (AI).",
      sharePrices: false,
      hours: { days: [1, 6], start: "09:00", end: "18:00" },
    });
  });
});
