import { describe, expect, it, vi } from "vitest";

vi.mock("@openpims/db/client", () => ({ db: {} }));
vi.mock("@/lib/agent/runner", () => ({
  configuredModel: vi.fn(),
  isAgentConfigured: () => false,
}));
vi.mock("@/lib/agent/tools", () => ({ getTool: vi.fn() }));
vi.mock("@/lib/sms", () => ({ sendSms: vi.fn() }));

const { assistantGuard, phoneFromAssistantSubject } =
  await import("../assistant");

const now = new Date("2026-11-02T15:00:00Z");
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);

type Row = Parameters<typeof assistantGuard>[0][number];
const row = (overrides: Partial<Row>): Row => ({
  id: "c1",
  direction: "inbound",
  subject: "SMS from +15555550199",
  content: "hi",
  status: "delivered",
  dedupeKey: null,
  createdAt: hoursAgo(1),
  ...overrides,
});

describe("assistantGuard", () => {
  it("lets the assistant answer a fresh conversation", () => {
    expect(assistantGuard([row({ id: "in1" })], now, "in1")).toBeNull();
  });

  it("never answers the same text twice", () => {
    const rows = [
      row({ dedupeKey: "assistant:reply:in1", direction: "outbound" }),
    ];
    expect(assistantGuard(rows, now, "in1")).toBe("skipped_duplicate");
  });

  it("stays quiet for 12 hours after staff reply", () => {
    const staff = row({
      direction: "outbound",
      status: "sent",
      createdAt: hoursAgo(3),
    });
    expect(assistantGuard([staff], now, "in2")).toBe("skipped_staff_active");
    const old = row({
      direction: "outbound",
      status: "sent",
      createdAt: hoursAgo(13),
    });
    expect(assistantGuard([old], now, "in2")).toBeNull();
  });

  it("does not treat its own drafts as a staff reply", () => {
    const draft = row({
      direction: "outbound",
      status: "draft",
      dedupeKey: "assistant:reply:x",
    });
    expect(assistantGuard([draft], now, "in2")).toBeNull();
  });

  it("pauses for a day after handing off to staff", () => {
    const handoff = row({
      dedupeKey: "assistant:handoff:in0",
      createdAt: hoursAgo(5),
    });
    expect(assistantGuard([handoff], now, "in2")).toBe("skipped_handoff");
  });

  it("caps replies per day", () => {
    const replies = Array.from({ length: 10 }, (_, index) =>
      row({
        id: `r${index}`,
        direction: "outbound",
        dedupeKey: `assistant:reply:i${index}`,
      }),
    );
    expect(assistantGuard(replies, now, "in99")).toBe("skipped_daily_limit");
  });

  it("reads the client's number from an assistant subject", () => {
    expect(
      phoneFromAssistantSubject(
        "Booking request from the assistant: +15555550199",
      ),
    ).toBe("+15555550199");
    expect(
      phoneFromAssistantSubject("Assistant draft reply to +15555550199"),
    ).toBe("+15555550199");
    expect(
      phoneFromAssistantSubject(
        "Assistant reply to +15555550199 (not sent: x)",
      ),
    ).toBe("+15555550199");
    expect(phoneFromAssistantSubject("Hello")).toBeNull();
  });
});
