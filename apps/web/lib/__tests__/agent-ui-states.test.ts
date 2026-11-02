import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AGENT_INSTRUCTION_MAX_LENGTH,
  isAgentInstructionValid,
} from "../agent/policy";

describe("agent UI states", () => {
  // The chat UI is shared by the Agent page and the "Ask" panel.
  const source = readFileSync("components/agent/agent-chat.tsx", "utf8");
  const pageSource = readFileSync("app/(dashboard)/agent/page.tsx", "utf8");
  const launcherSource = readFileSync(
    "components/agent/assistant-launcher.tsx",
    "utf8",
  );
  const routerSource = readFileSync("server/routers/agent.ts", "utf8");
  const apiRouteSource = readFileSync("app/api/v1/agent/route.ts", "utf8");

  it("fails closed until agent status is loaded and configured", () => {
    expect(source).toContain(
      'import { useEffect, useRef, useState } from "react"',
    );
    expect(source).toContain("const verifiedAgentStatus =");
    expect(source).toContain(
      "status.error || statusMissing || !status.data ? null : status.data",
    );
    expect(source).toContain(
      "const configured = verifiedAgentStatus\n    ? verifiedAgentStatus.configured\n    : false",
    );
    expect(source).toContain(
      "const statusMissing = !status.isLoading && !status.error && !status.data",
    );
    expect(source).toContain(
      "const canRun = !status.isLoading && configured && canUseAi",
    );
    expect(source).toContain(
      "const submitDisabled =\n    !canRun || !isAgentInstructionValid(instruction) || run.isPending",
    );
    expect(source).toContain(
      "if (!canRun && allowWrites) {\n      setAllowWrites(false);",
    );
    expect(source).toContain("if (submitDisabled) return");
    expect(source).toContain("onSettled: () => setAllowWrites(false)");
    expect(source).toContain("disabled={!canRun || run.isPending}");
    expect(source).toContain("disabled={submitDisabled}");
    expect(source).not.toContain("status.data?.configured");
  });

  it("makes clinical write mode explicit and one-message only", () => {
    expect(source).toContain("Allow changes");
    expect(source).toContain("booking visits, recording");
    expect(source).toContain("saving SOAP drafts (never finalized)");
    expect(source).toContain("It turns off\n              after that message.");
    expect(source).not.toContain("Allow writes (e.g. booking appointments)");
  });

  it("asks before retrying a blocked change, and only for the latest reply", () => {
    expect(source).toContain(
      'export const WRITES_DISABLED_ERROR = "Write tools are disabled for this run."',
    );
    expect(source).toContain("replyNeedsWriteApproval(m.toolCalls)");
    expect(source).toContain("m.id === lastReplyId &&");
    expect(source).toContain("send(text, true, { echo: false })");
    expect(source).toContain("Allow this change");
  });

  it("surfaces agent status loading and error states", () => {
    expect(source).toContain("Checking agent configuration");
    expect(source).toContain("Could not check agent status");
    expect(source).toContain("Agent status is unavailable");
    expect(source).toContain("onClick={() => void status.refetch()}");
    expect(source).toContain("status.error.message");
    expect(source).toContain("The agent is not available right now.");
    // Hosted clinics must never see raw env-var instructions; self-host
    // admins keep them because they can actually act on them.
    expect(source).toContain("verifiedAgentStatus?.hosted ? (");
    expect(source.indexOf("verifiedAgentStatus?.hosted ? (")).toBeLessThan(
      source.indexOf("GOOGLE_VERTEX_PROJECT"),
    );
    expect(source.indexOf(": status.error ? (")).toBeLessThan(
      source.indexOf(": statusMissing ? ("),
    );
    expect(source.indexOf(": statusMissing ? (")).toBeLessThan(
      source.indexOf(": !configured ? ("),
    );
    expect(source).toContain(": !configured ? (");
    expect(source).toContain("Add a card to try AI");
    expect(source).toContain('router.push("/settings?tab=billing")');
    expect(source.indexOf(": needsBillingSetup ? (")).toBeLessThan(
      source.indexOf(": !configured ? ("),
    );
  });

  it("bounds instructions with the shared agent policy", () => {
    expect(AGENT_INSTRUCTION_MAX_LENGTH).toBe(2000);
    expect(isAgentInstructionValid("Summarize today's appointments")).toBe(
      true,
    );
    expect(isAgentInstructionValid(" ".repeat(8))).toBe(false);
    expect(isAgentInstructionValid("A".repeat(2001))).toBe(false);

    expect(routerSource).toContain('from "@/lib/agent/policy"');
    expect(routerSource).toContain(
      "instruction: z.string().trim().min(1).max(AGENT_INSTRUCTION_MAX_LENGTH)",
    );
    expect(apiRouteSource).toContain('from "@/lib/agent/policy"');
    expect(apiRouteSource).toContain(
      "instruction: z.string().trim().min(1).max(AGENT_INSTRUCTION_MAX_LENGTH)",
    );
    expect(source).toContain('from "@/lib/agent/policy"');
    expect(source).toContain("maxLength={AGENT_INSTRUCTION_MAX_LENGTH}");
    expect(source).toContain("aria-invalid={instructionInvalid || undefined}");
    expect(source).toContain("!isAgentInstructionValid(instruction)");
  });

  it("gates direct-route access to roles that can run the agent", () => {
    expect(pageSource).toContain('import { useRouter } from "next/navigation"');
    expect(pageSource).toContain('import { useSession } from "next-auth/react"');
    expect(launcherSource).toContain(
      "export function canRunAgentRole(role?: string | null): boolean",
    );
    expect(launcherSource).toContain('role === "admin" || role === "veterinarian"');
    expect(launcherSource).toContain(
      "if (!canRunAgentRole(role) || onAgentPage) return null;",
    );
    expect(pageSource).toContain("const { data: session, status } = useSession()");
    expect(pageSource).toContain('if (status === "loading")');
    expect(pageSource).toContain("if (!canRunAgentRole(session?.user?.role))");
    expect(pageSource).toContain("Agent access is restricted");
    expect(pageSource).toContain(
      'return <AgentRunner isAdmin={session?.user?.role === "admin"} />',
    );
    expect(pageSource).toContain("function AgentRunner({ isAdmin }");
    // Status is only queried inside the chat, after the role gate renders it.
    expect(pageSource).not.toContain("trpc.agent.status.useQuery");
    expect(source).toContain("trpc.agent.status.useQuery");
    expect(routerSource).toContain('requireRole("admin", "veterinarian")');
  });
});
