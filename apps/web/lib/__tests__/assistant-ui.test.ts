import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assistantHintsForPath,
  canRunAgentRole,
} from "@/components/agent/assistant-launcher";
import {
  safeHref,
  tokenizeInline,
} from "@/components/agent/agent-message-text";
import {
  WRITES_DISABLED_ERROR,
  replyNeedsWriteApproval,
} from "@/components/agent/agent-chat";

const ID = "0b9c1e7a-3f1d-4a52-9a77-1c2d3e4f5a6b";

describe("assistant launcher", () => {
  it("reads the patient or visit on screen from the URL", () => {
    expect(assistantHintsForPath(`/patients/${ID}`)).toEqual({ patientId: ID });
    expect(assistantHintsForPath(`/patients/${ID}/edit`)).toEqual({
      patientId: ID,
    });
    expect(assistantHintsForPath(`/encounters/${ID}`)).toEqual({
      appointmentId: ID,
    });
    expect(assistantHintsForPath("/patients/new")).toEqual({});
    expect(assistantHintsForPath(`/clients/${ID}`)).toEqual({});
    expect(assistantHintsForPath("/")).toEqual({});
    expect(assistantHintsForPath(null)).toEqual({});
  });

  it("is only for roles that can run the agent", () => {
    expect(canRunAgentRole("admin")).toBe(true);
    expect(canRunAgentRole("veterinarian")).toBe(true);
    expect(canRunAgentRole("technician")).toBe(false);
    expect(canRunAgentRole("front_desk")).toBe(false);
    expect(canRunAgentRole(undefined)).toBe(false);
  });

  it("is mounted in the dashboard layout", () => {
    const layout = readFileSync("app/(dashboard)/layout.tsx", "utf8");
    expect(layout).toContain("<AssistantLauncher />");
  });
});

describe("assistant message rendering", () => {
  it("allows in-app paths and http(s) links only", () => {
    expect(safeHref(`/patients/${ID}`)).toBe(`/patients/${ID}`);
    expect(safeHref("https://www.google.com/maps/dir/?api=1&destination=x")).toBe(
      "https://www.google.com/maps/dir/?api=1&destination=x",
    );
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("//evil.example")).toBeNull();
    expect(safeHref("data:text/html,hi")).toBeNull();
  });

  it("splits bold text, Markdown links and bare URLs", () => {
    expect(
      tokenizeInline(
        `**Bella** is due. [Open chart](/patients/${ID}) or https://example.com/x`,
      ),
    ).toEqual([
      { type: "bold", value: "Bella" },
      { type: "text", value: " is due. " },
      { type: "link", label: "Open chart", href: `/patients/${ID}` },
      { type: "text", value: " or " },
      { type: "link", label: "https://example.com/x", href: "https://example.com/x" },
    ]);
  });

  it("shows an unsafe link's label as plain text", () => {
    expect(tokenizeInline("[click](javascript:alert(1))")).toEqual([
      { type: "text", value: "click" },
      { type: "text", value: ")" },
    ]);
  });
});

describe("blocked change approval", () => {
  it("matches the runner's write-gate error exactly", () => {
    const runner = readFileSync("lib/agent/runner.ts", "utf8");
    expect(runner).toContain(`call.error = "${WRITES_DISABLED_ERROR}"`);
  });

  it("asks for approval only when a write tool was blocked", () => {
    expect(replyNeedsWriteApproval(undefined)).toBe(false);
    expect(
      replyNeedsWriteApproval([{ name: "get_my_day", input: {} }]),
    ).toBe(false);
    expect(
      replyNeedsWriteApproval([
        { name: "save_soap_draft", input: {}, error: WRITES_DISABLED_ERROR },
      ]),
    ).toBe(true);
  });
});
