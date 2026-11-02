import { describe, expect, it } from "vitest";
import {
  CHECK_IN_QUESTIONS,
  checkInAnswersInput,
  checkInHasRequiredAnswers,
  formatCheckInForClinicalContext,
  readStoredCheckInAnswers,
  toStoredCheckInAnswers,
} from "../form";
import {
  checkInIsOpen,
  checkInPath,
  checkInToken,
  isCheckInLinkShape,
  verifyCheckInToken,
} from "../link";

const APPT = "4f6c1c9e-8d0b-4b65-9d55-2f1a8f0b7c11";

describe("check-in form answers", () => {
  it("covers problems, habits, food, medications, and goals", () => {
    const keys = CHECK_IN_QUESTIONS.map((q) => q.key);
    for (const key of [
      "mainConcerns",
      "energy",
      "temperature",
      "diet",
      "medications",
      "supplements",
      "goals",
    ]) {
      expect(keys).toContain(key);
    }
  });

  it("accepts known answers, trims text, and drops empty strings", () => {
    const parsed = checkInAnswersInput.parse({
      mainConcerns: "  stiff in the mornings ",
      energy: "low",
      diet: "",
    });
    expect(parsed).toEqual({
      mainConcerns: "stiff in the mornings",
      energy: "low",
    });
  });

  it("rejects unknown keys and invalid choices", () => {
    expect(checkInAnswersInput.safeParse({ hacker: "x" }).success).toBe(false);
    expect(checkInAnswersInput.safeParse({ energy: "sleepy" }).success).toBe(
      false,
    );
    expect(
      checkInAnswersInput.safeParse({ mainConcerns: "x".repeat(2_001) })
        .success,
    ).toBe(false);
  });

  it("requires the main concern", () => {
    expect(checkInHasRequiredAnswers({ goals: "walk more" })).toBe(false);
    expect(checkInHasRequiredAnswers({ mainConcerns: "itchy" })).toBe(true);
  });

  it("round-trips stored answers and ignores tampered values", () => {
    const stored = toStoredCheckInAnswers({
      mainConcerns: "limping",
      thirst: "more",
    });
    expect(stored.version).toBe(1);
    expect(readStoredCheckInAnswers(stored)).toEqual({
      mainConcerns: "limping",
      thirst: "more",
    });
    expect(
      readStoredCheckInAnswers({
        version: 1,
        answers: { thirst: "bogus", extra: "x", diet: 5, goals: "comfort" },
      }),
    ).toEqual({ goals: "comfort" });
    expect(readStoredCheckInAnswers(null)).toEqual({});
  });

  it("summarizes answers by section for clinical tools", () => {
    const text = formatCheckInForClinicalContext({
      mainConcerns: "Stiff\nafter naps",
      temperature: "cool",
      diet: "Raw turkey",
      goals: "Fewer NSAIDs",
    });
    expect(text).toContain(
      "Problems and concerns:\n- Concerns: Stiff after naps",
    );
    expect(text).toContain(
      "- Warm/cool preference: Seeks cool (tile floors, shade, AC)",
    );
    expect(text).toContain("Food:\n- Diet: Raw turkey");
    expect(text).toContain("Your goals:\n- Owner goals: Fewer NSAIDs");
    expect(text).not.toContain("Medications");
  });
});

describe("check-in link", () => {
  it("builds a stable signed path that verifies", () => {
    const token = checkInToken(APPT);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(checkInPath(APPT)).toBe(`/check-in/${APPT}/${token}`);
    expect(verifyCheckInToken(APPT, token)).toBe(true);
    expect(verifyCheckInToken(APPT.toUpperCase(), token)).toBe(true);
  });

  it("rejects tokens for other visits and malformed input", () => {
    const other = "0b1d6c3e-1111-4222-8333-944455556666";
    expect(verifyCheckInToken(other, checkInToken(APPT))).toBe(false);
    expect(verifyCheckInToken(APPT, "0".repeat(64))).toBe(false);
    expect(isCheckInLinkShape("not-a-uuid", checkInToken(APPT))).toBe(false);
    expect(isCheckInLinkShape(APPT, "abc")).toBe(false);
  });

  it("closes after the visit starts, finishes, or is cancelled", () => {
    const now = new Date("2026-11-05T15:00:00Z");
    const future = new Date("2026-11-06T15:00:00Z");
    expect(checkInIsOpen({ status: "scheduled", startTime: future }, now)).toBe(
      true,
    );
    expect(checkInIsOpen({ status: "confirmed", startTime: future }, now)).toBe(
      true,
    );
    expect(checkInIsOpen({ status: "cancelled", startTime: future }, now)).toBe(
      false,
    );
    expect(checkInIsOpen({ status: "no_show", startTime: future }, now)).toBe(
      false,
    );
    expect(
      checkInIsOpen(
        { status: "confirmed", startTime: future, deletedAt: now },
        now,
      ),
    ).toBe(false);
    expect(
      checkInIsOpen(
        { status: "in_exam", startTime: new Date("2026-11-05T14:00:00Z") },
        now,
      ),
    ).toBe(true);
    expect(
      checkInIsOpen(
        { status: "confirmed", startTime: new Date("2026-11-05T12:00:00Z") },
        now,
      ),
    ).toBe(false);
  });
});
