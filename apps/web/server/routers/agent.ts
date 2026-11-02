import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  createRouter,
  protectedProcedure,
  requireFeature,
  requireRole,
} from "../trpc";
import { practices, users } from "@openpims/db";
import type { Database } from "@openpims/db/client";
import {
  runAgent,
  isAgentConfigured,
  agentSetupHint,
  AGENT_TOOL_NAMES,
  AgentNotConfiguredError,
  AgentBillingAccessError,
  AgentPracticeNotFoundError,
  AgentRateLimitedError,
  AgentRecoveryHoldError,
} from "@/lib/agent";
import { AGENT_INSTRUCTION_MAX_LENGTH } from "@/lib/agent/policy";
import {
  MORNING_BRIEFING_ROLES,
  morningBriefingFromSettings,
} from "@/lib/agent/morning-briefing";
import { billingEnforced } from "@/lib/billing/plans";
import { readHostedAiAccess } from "@/lib/billing/ai-access";

export { AGENT_INSTRUCTION_MAX_LENGTH } from "@/lib/agent/policy";

// The OpenVPM Agent is a Cloud feature on hosted; unrestricted on self-host.
const agentProcedure = protectedProcedure
  .use(requireRole("admin", "veterinarian"))
  .use(requireFeature("agent"));

type AgentContext = {
  db: Database;
  practiceId: string;
};

function activePracticeWhere(practiceId: string) {
  return and(eq(practices.id, practiceId), isNull(practices.deletedAt));
}

function practiceNotFound(): TRPCError {
  return new TRPCError({ code: "NOT_FOUND", message: "Practice not found" });
}

async function assertActivePractice(ctx: AgentContext) {
  const [practice] = await ctx.db
    .select({ id: practices.id })
    .from(practices)
    .where(activePracticeWhere(ctx.practiceId))
    .limit(1);

  if (!practice) {
    throw practiceNotFound();
  }
}

export const agentRouter = createRouter({
  /** Whether the agent is enabled (API key present) and what it can do. */
  status: protectedProcedure.query(async ({ ctx }) => {
    const hosted = billingEnforced();
    const access = await readHostedAiAccess(ctx.db, ctx.practiceId, {
      enforced: hosted,
    });
    if (!access) throw practiceNotFound();

    return {
      configured: isAgentConfigured(),
      // Self-host only: which setting is missing (never a secret value).
      setupHint: hosted ? null : agentSetupHint(),
      // Hosted users get a friendly "unavailable" message when unconfigured;
      // self-host admins get env-var instructions they can act on.
      hosted,
      canUseAi: access.allowed,
      needsBillingSetup: access.reason === "billing_setup_required",
      accessMessage: access.message,
      tools: AGENT_TOOL_NAMES,
    };
  }),

  /**
   * Morning briefing email: the send time and who gets it. Administrators see
   * and manage every veterinarian/administrator; a veterinarian only
   * themselves.
   */
  briefingSettings: agentProcedure.query(async ({ ctx }) => {
      const [practice] = await ctx.db
        .select({ settings: practices.settings })
        .from(practices)
        .where(activePracticeWhere(ctx.practiceId))
        .limit(1);
      if (!practice) throw practiceNotFound();
      const config = morningBriefingFromSettings(practice.settings);
      const isAdmin = ctx.user.role === "admin";
      const staff = await ctx.db
        .select({ id: users.id, name: users.name, role: users.role })
        .from(users)
        .where(
          and(
            eq(users.practiceId, ctx.practiceId),
            isNull(users.deletedAt),
            inArray(users.role, [...MORNING_BRIEFING_ROLES]),
            ...(isAdmin ? [] : [eq(users.id, ctx.user.id)]),
          ),
        )
        .orderBy(users.name);
      return {
        hour: config.hour,
        canManageOthers: isAdmin,
        people: staff.map((u) => ({
          id: u.id,
          name: u.name,
          role: u.role,
          isMe: u.id === ctx.user.id,
          enabled: Boolean(config.recipients[u.id]),
        })),
      };
    }),

  setBriefing: agentProcedure
    .input(
      z.object({
        userId: z.string().guid(),
        enabled: z.boolean(),
        // The send time is practice-wide; only administrators change it.
        hour: z.number().int().min(0).max(23).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const isAdmin = ctx.user.role === "admin";
      if (!isAdmin && (input.userId !== ctx.user.id || input.hour !== undefined)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only an administrator can change this for others or set the time.",
        });
      }
      const [target] = await ctx.db
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.id, input.userId),
            eq(users.practiceId, ctx.practiceId),
            isNull(users.deletedAt),
            inArray(users.role, [...MORNING_BRIEFING_ROLES]),
          ),
        )
        .limit(1);
      if (!target) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Morning briefings go to veterinarians and administrators only.",
        });
      }
      return ctx.db.transaction(async (tx) => {
        const [practice] = await tx
          .select({ settings: practices.settings })
          .from(practices)
          .where(activePracticeWhere(ctx.practiceId))
          .limit(1)
          .for("update");
        if (!practice) throw practiceNotFound();
        const config = morningBriefingFromSettings(practice.settings);
        const recipients = { ...config.recipients };
        if (input.enabled) {
          recipients[input.userId] = recipients[input.userId] ?? { lastSentDate: null };
        } else {
          delete recipients[input.userId];
        }
        const next = { hour: input.hour ?? config.hour, recipients };
        await tx
          .update(practices)
          .set({
            settings: sql`coalesce(${practices.settings}, '{}'::jsonb) || ${JSON.stringify({ morningBriefing: next })}::jsonb`,
          })
          .where(eq(practices.id, ctx.practiceId));
        return { hour: next.hour, enabled: input.enabled };
      });
    }),

  /** Run the OpenVPM Agent against a natural-language instruction. */
  run: agentProcedure
    .input(
      z.object({
        instruction: z.string().trim().min(1).max(AGENT_INSTRUCTION_MAX_LENGTH),
        // Writes (e.g. booking) are opt-in per run and require an explicit flag.
        allowWrites: z.boolean().default(false),
        // Prior turns (oldest first) for multi-turn chat. Bounded to keep the
        // prompt small; the client sends a trailing window of the conversation.
        history: z
          .array(
            z.object({
              role: z.enum(["user", "assistant"]),
              content: z
                .string()
                .trim()
                .min(1)
                .max(AGENT_INSTRUCTION_MAX_LENGTH),
            }),
          )
          .max(20)
          .optional(),
        // Answer for speech (Siri): short, no links or Markdown.
        voice: z.boolean().optional(),
        // What the clinician is looking at, so "this patient" resolves.
        context: z
          .object({
            patientId: z.string().guid().optional(),
            appointmentId: z.string().guid().optional(),
          })
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertActivePractice(ctx);
      try {
        return await runAgent({
          instruction: input.instruction,
          allowWrites: input.allowWrites,
          history: input.history,
          hints: input.voice ? { ...input.context, voice: true } : input.context,
          context: {
            db: ctx.db,
            practiceId: ctx.practiceId,
            userId: ctx.user.id,
            staffUser: {
              id: ctx.user.id,
              name: ctx.user.name,
              role: ctx.user.role,
            },
            postCommitEffect: ctx.postCommitEffect,
          },
        });
      } catch (e) {
        if (e instanceof AgentBillingAccessError) {
          throw new TRPCError({ code: "FORBIDDEN", message: e.message });
        }
        if (e instanceof AgentNotConfiguredError) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: e.message,
          });
        }
        if (e instanceof AgentRateLimitedError) {
          throw new TRPCError({
            code: "TOO_MANY_REQUESTS",
            message: e.message,
          });
        }
        if (e instanceof AgentRecoveryHoldError) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: e.message,
          });
        }
        if (e instanceof AgentPracticeNotFoundError) {
          throw practiceNotFound();
        }
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: e instanceof Error ? e.message : "Agent run failed",
        });
      }
    }),
});
