import { NextRequest, NextResponse } from "next/server";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { appRouter } from "@/server/routers/_app";
import { createTRPCContext } from "@/server/trpc";
import { readJsonRequestBody } from "@/lib/request-json";
import { isSameOriginRequest } from "@/lib/request-origin";
import { AGENT_INSTRUCTION_MAX_LENGTH } from "@/lib/agent/policy";
import { spokenAnswer } from "@/lib/agent/spoken";
import { WRITES_DISABLED_ERROR } from "@/lib/agent/runner";

/**
 * Voice entry point for the staff iPhone app's Siri actions and smart-glasses
 * mode. Uses the staff
 * member's existing sign-in cookie and runs the same `agent.run` procedure
 * as the web assistant (same roles, feature gate, tenant scope and rate
 * limits) and returns plain text suitable for speech.
 *
 * Read-only unless the client asks for spoken approval (smart-glasses mode,
 * `confirm: true`): then a change the assistant wants to make comes back as
 * `needsApproval`, and the client runs it again with `approved: true` only
 * after the staff member says yes, just as the web assistant's "Allow this
 * change" button does. Siri never sends either flag, so it stays read-only.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Native clients send this; a browser form cannot set a custom header. */
const ASSISTANT_CLIENT_HEADER = "x-openvpm-client";

const NO_STORE = { "Cache-Control": "private, no-store, max-age=0" };
const body = z.object({
  question: z.string().trim().min(1).max(AGENT_INSTRUCTION_MAX_LENGTH),
  /**
   * What the staff member has open in the app (the smart-glasses mode sends
   * it), so "this patient" and "this visit" resolve without naming them.
   * The agent still checks access to whatever it reads.
   */
  context: z
    .object({
      patientId: z.string().guid().optional(),
      appointmentId: z.string().guid().optional(),
    })
    .optional(),
  /** The client can ask aloud for approval before a change is saved. */
  confirm: z.boolean().optional(),
  /** The staff member said yes to the change proposed in `history`. */
  approved: z.boolean().optional(),
  /** The request and the proposed change, for an approved run. */
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().trim().min(1).max(AGENT_INSTRUCTION_MAX_LENGTH),
      }),
    )
    .max(4)
    .optional(),
});

function reply(answer: string, status = 200, needsApproval = false) {
  return NextResponse.json(
    needsApproval ? { answer, needsApproval } : { answer },
    { status, headers: NO_STORE },
  );
}

const STATUS_FOR_CODE: Partial<Record<TRPCError["code"], number>> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  TOO_MANY_REQUESTS: 429,
  PRECONDITION_FAILED: 503,
  NOT_FOUND: 404,
  BAD_REQUEST: 400,
};

export async function POST(req: NextRequest) {
  if (!req.headers.get(ASSISTANT_CLIENT_HEADER) || !isSameOriginRequest(req)) {
    return reply("This request isn't allowed.", 403);
  }
  const parsed = await readJsonRequestBody(req);
  const input = parsed.ok ? body.safeParse(parsed.data) : null;
  if (!input?.success) return reply("I didn't catch a question.", 400);

  try {
    const ctx = await createTRPCContext({ req });
    if (!ctx.session?.user) {
      return reply("Open the app and sign in first, then ask again.", 401);
    }
    const caller = appRouter.createCaller(ctx);
    const confirm = input.data.confirm === true;
    const approved = confirm && input.data.approved === true;
    const result = await caller.agent.run({
      instruction: input.data.question,
      allowWrites: approved,
      voice: true,
      voiceApproval: confirm,
      history: approved ? input.data.history : undefined,
      context: input.data.context,
    });
    const needsApproval =
      confirm &&
      !approved &&
      result.toolCalls.some((call) => call.error === WRITES_DISABLED_ERROR);
    return reply(
      spokenAnswer(result.text) || "I don't have an answer for that.",
      200,
      needsApproval,
    );
  } catch (error) {
    if (error instanceof TRPCError) {
      const status = STATUS_FOR_CODE[error.code] ?? 500;
      const message =
        status === 401
          ? "Open the app and sign in first, then ask again."
          : status === 403
            ? "Your login can't use the assistant."
            : status === 429
              ? "Too many questions just now. Try again in a minute."
              : status === 503
                ? "The assistant isn't available right now."
                : "Something went wrong. Try again in the app.";
      return reply(message, status);
    }
    console.error("[assistant.ask] failed");
    return reply("Something went wrong. Try again in the app.", 500);
  }
}
