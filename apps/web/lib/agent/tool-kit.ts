import type { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "@openpims/db/client";
import { practices } from "@openpims/db";

/**
 * Shared types and helpers for agent tools. Kept separate from tools.ts so
 * tool groups (e.g. vet-tools.ts) can be split into their own modules without
 * an import cycle back into the AGENT_TOOLS registry.
 */

/** The signed-in staff member a dashboard run acts for. */
export interface AgentStaffUser {
  id: string;
  name: string;
  role: string;
}

export interface AgentToolContext {
  db: Database;
  practiceId: string;
  userId: string;
  /**
   * Present only when a signed-in staff member runs the agent from the
   * dashboard. API-key and automated runs leave it unset, which hides tools
   * flagged `requiresStaffUser` (personal to-do lists, chart drafting).
   */
  staffUser?: AgentStaffUser;
  postCommitEffect?: (effect: (rootDb: Database) => Promise<void>) => void;
}

export type AgentWriteApiScope = "appointments:write" | "records:write";

export interface AgentTool {
  name: string;
  description: string;
  /** JSON Schema sent to the model as the tool's input_schema. */
  inputSchema: Record<string, unknown>;
  /** Runtime validation of the model-supplied args. */
  zod: z.ZodTypeAny;
  readOnly: boolean;
  requiredApiScopes?: AgentWriteApiScope[];
  /** Only offered to runs made by a signed-in staff member. */
  requiresStaffUser?: boolean;
  execute(args: unknown, ctx: AgentToolContext): Promise<unknown>;
}

export class AgentPracticeNotFoundError extends Error {
  constructor() {
    super("Practice not found");
    this.name = "AgentPracticeNotFoundError";
  }
}

export async function practiceTimeZone(
  ctx: AgentToolContext,
): Promise<string | null> {
  const [practice] = await ctx.db
    .select({ timezone: practices.timezone })
    .from(practices)
    .where(and(eq(practices.id, ctx.practiceId), isNull(practices.deletedAt)))
    .limit(1);
  if (!practice) {
    throw new AgentPracticeNotFoundError();
  }
  return practice.timezone ?? null;
}

export function clientName(first?: string | null, last?: string | null): string {
  return [first, last].filter(Boolean).join(" ");
}
