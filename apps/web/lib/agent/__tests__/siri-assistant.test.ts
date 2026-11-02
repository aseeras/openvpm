import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { spokenAnswer } from "../spoken";
import { buildRunContextPrompt } from "../runner";

describe("spokenAnswer", () => {
  it("keeps link labels and drops URLs and Markdown symbols", () => {
    expect(
      spokenAnswer(
        "## Today\n- **9:00 AM** [Bella](/patients/p1) at 12 Palm Way\n- See https://maps.example/x for directions",
      ),
    ).toBe("Today\n9:00 AM Bella at 12 Palm Way\nSee for directions");
  });

  it("returns an empty string for nothing to say", () => {
    expect(spokenAnswer("  \n\n ")).toBe("");
  });
});

describe("voice runs", () => {
  it("tell the model the answer will be spoken and is read-only", () => {
    const prompt = buildRunContextPrompt({
      now: new Date("2026-11-02T12:00:00Z"),
      timeZone: "America/New_York",
      hints: { voice: true },
    });
    expect(prompt).toContain("read aloud");
    expect(prompt).toContain("Nothing can be changed from voice");
  });

  it("tell glasses mode to ask for a spoken yes before a change", () => {
    const prompt = buildRunContextPrompt({
      now: new Date("2026-11-02T12:00:00Z"),
      timeZone: "America/New_York",
      hints: { voice: true, voiceApproval: true },
    });
    expect(prompt).toContain("read aloud");
    expect(prompt).toContain("say yes to save it");
    expect(prompt).not.toContain("Nothing can be changed from voice");
  });

  it("the voice endpoint requires the native header and same origin, and only writes after a spoken yes", () => {
    const route = readFileSync("app/api/assistant/ask/route.ts", "utf8");
    expect(route).toContain('"x-openvpm-client"');
    expect(route).toContain("isSameOriginRequest(req)");
    expect(route).toContain("const approved = confirm && input.data.approved === true;");
    expect(route).toContain("allowWrites: approved");
    expect(route).toContain("voice: true");
    expect(route).toContain("call.error === WRITES_DISABLED_ERROR");
  });

  it("passes the on-screen patient or visit through to the agent", () => {
    const route = readFileSync("app/api/assistant/ask/route.ts", "utf8");
    expect(route).toContain("patientId: z.string().guid().optional()");
    expect(route).toContain("context: input.data.context");
  });
});
