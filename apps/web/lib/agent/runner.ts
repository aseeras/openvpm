import {
  generateText,
  stepCountIs,
  tool,
  type LanguageModel,
  type ToolSet,
} from "ai";
import { createVertex } from "@ai-sdk/google-vertex";
import { createAnthropic } from "@ai-sdk/anthropic";
import { getVercelOidcToken } from "@vercel/oidc";
import { ExternalAccountClient } from "google-auth-library";
import {
  AGENT_TOOLS,
  AgentPracticeNotFoundError,
  type AgentTool,
  type AgentToolContext,
} from "./tools";
import { practiceTimeZone } from "./tool-kit";
import { recordUsage } from "@/lib/billing/usage";
import { readHostedAiAccess } from "@/lib/billing/ai-access";
import { rateLimit } from "@/lib/rate-limit";
import {
  lockPracticeForExternalSideEffects,
  RECOVERY_HOLD_BLOCK_MESSAGE,
} from "@/lib/recovery-hold";

/**
 * Provider-agnostic agent runner (Vercel AI SDK). The active model is chosen by
 * `AI_MODEL` (falling back to the legacy `AGENT_MODEL`); the provider is inferred
 * from the model id, so the same code runs on Gemini or Claude with only an env
 * change. Each tool already carries a Zod schema, which the AI SDK consumes
 * directly, and the SDK runs the tool-use loop for us up to MAX_ITERATIONS.
 */
const DEFAULT_MODEL = "gemini-3.5-flash";
/**
 * Used when no model is named, Vertex AI is not configured, and an Anthropic
 * key is present, so a self-hosted clinic that only adds ANTHROPIC_API_KEY
 * gets a working agent instead of a "configure Vertex" banner.
 */
/** Error a write tool returns when the run did not allow writes. */
export const WRITES_DISABLED_ERROR = "Write tools are disabled for this run.";

export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-5-5";
const MAX_ITERATIONS = 10;
// Room for a full SOAP draft passed as tool input plus the reply.
const MAX_OUTPUT_TOKENS = 4096;
export const AGENT_RUN_RATE_WINDOW_MS = 60_000;
export const AGENT_RUN_ACTOR_RATE_LIMIT = 20;
export const AGENT_RUN_PRACTICE_RATE_LIMIT = 120;

const SYSTEM_PROMPT = `You are the OpenVPM Agent, an operations assistant embedded in an open-source veterinary practice management system.

You help practice staff by using the provided tools to read and act on practice data. Guidelines:
- Always use tools to ground answers in real data. Never invent client names, patient records, appointment times, or doses.
- You operate on a single practice's data; you cannot see other practices.
- For any drug dose, use calculate_drug_dose and present it as a reference range that the prescribing clinician must verify. Never present a dose as a final prescribing decision.
- Before booking an appointment, confirm you have the right client and patient (use find_client / get_patient_summary first when ids are not given).
- Be concise and clinical. Surface warnings the tools return.
- When a tool returns a link (chartLink, visitLink, directions, link), include it as a Markdown link, e.g. [Open Bella's chart](/patients/…), so the clinician can tap through.
- For SOAP notes: organize only what the clinician told you into a draft with save_soap_draft. Never finalize, never add findings they did not state, and remind them to review and sign in the visit.
- You cannot prescribe, record refills, or send messages to clients. Prepare the information and link to where the clinician does it.
- If a change is needed but write tools are disabled for this run, say exactly what you would save and ask the clinician to allow the change.`;

export interface AgentRunContextHints {
  /** Patient the clinician is looking at in the app, if any. */
  patientId?: string;
  /** Visit (appointment) the clinician is looking at, if any. */
  appointmentId?: string;
  /** The answer will be read aloud (e.g. by Siri). */
  voice?: boolean;
  /**
   * Voice client that can ask the clinician aloud to approve a change and
   * run again with writes allowed (smart-glasses mode). Siri stays read-only.
   */
  voiceApproval?: boolean;
}

/** Per-run context appended to the system prompt: who, when, and where. */
export function buildRunContextPrompt(input: {
  now: Date;
  timeZone: string | null;
  staffUser?: { name: string; role: string };
  hints?: AgentRunContextHints;
}): string {
  const timeZone = input.timeZone ?? "UTC";
  let nowText: string;
  try {
    nowText = new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone,
    }).format(input.now);
  } catch {
    nowText = input.now.toISOString();
  }
  const lines = [`Current date and time: ${nowText} (${timeZone}).`];
  if (input.staffUser) {
    lines.push(
      `You are helping ${input.staffUser.name} (role: ${input.staffUser.role}). "My" and "me" refer to them.`,
    );
  }
  if (input.hints?.patientId) {
    lines.push(
      `They are currently viewing patient ${input.hints.patientId}; "this patient" or "this pet" means that patient.`,
    );
  }
  if (input.hints?.appointmentId) {
    lines.push(
      `They are currently viewing visit (appointment) ${input.hints.appointmentId}; "this visit" means that appointment.`,
    );
  }
  if (input.hints?.voice) {
    const spoken =
      "This answer will be read aloud by a voice assistant. Use plain spoken sentences: no links, Markdown, tables or ids. Keep it brief (for a day's schedule, one short sentence per visit).";
    lines.push(
      input.hints.voiceApproval
        ? `${spoken} Changes need the clinician's spoken yes: if a change is needed, use the tool as usual; if write tools are disabled, say in one or two sentences exactly what you would save, then ask them to say yes to save it.`
        : `${spoken} Nothing can be changed from voice; if asked to change something, say to open the app.`,
    );
  }
  return lines.join("\n");
}

export interface AgentToolCall {
  name: string;
  input: unknown;
  result?: unknown;
  error?: string;
}

export interface AgentRunResult {
  text: string;
  toolCalls: AgentToolCall[];
  iterations: number;
  stopReason: string | null;
}

export class AgentNotConfiguredError extends Error {
  constructor() {
    super(
      "OpenVPM Agent is not configured. Configure Google Vertex AI for Gemini, or set ANTHROPIC_API_KEY for an explicit Claude model.",
    );
    this.name = "AgentNotConfiguredError";
  }
}

export class AgentRateLimitedError extends Error {
  constructor(
    public readonly retryAfterSeconds: number,
    public readonly limit: number,
    public readonly resetAt: Date,
  ) {
    super("Too many agent runs. Try again later.");
    this.name = "AgentRateLimitedError";
  }
}

export class AgentRecoveryHoldError extends Error {
  constructor() {
    super(RECOVERY_HOLD_BLOCK_MESSAGE);
    this.name = "AgentRecoveryHoldError";
  }
}

export class AgentBillingAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentBillingAccessError";
  }
}

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Resolve the model id from request override → AI_MODEL → legacy AGENT_MODEL
 * → default. The default is Gemini on Vertex, or Claude when only an
 * Anthropic key is configured.
 */
function activeModelId(override?: string): string {
  return (
    nonBlank(override) ??
    nonBlank(process.env.AI_MODEL) ??
    nonBlank(process.env.AGENT_MODEL) ??
    (!hasVertexConfiguration() && anthropicApiKey()
      ? DEFAULT_CLAUDE_MODEL
      : DEFAULT_MODEL)
  );
}

/** Google (Gemini) vs Anthropic (Claude) inferred from the model id. */
function isGoogleModel(modelId: string): boolean {
  return /^(google\/|models\/)?gemini/i.test(modelId);
}

function vertexProject(): string | undefined {
  return nonBlank(process.env.GOOGLE_VERTEX_PROJECT);
}

function vertexLocation(): string | undefined {
  return nonBlank(process.env.GOOGLE_VERTEX_LOCATION);
}

function vertexServiceAccountEmail(): string | undefined {
  return nonBlank(process.env.GCP_SERVICE_ACCOUNT_EMAIL);
}

function vertexProjectNumber(): string | undefined {
  return nonBlank(process.env.GCP_PROJECT_NUMBER);
}

function vertexWorkloadIdentityPoolId(): string | undefined {
  return nonBlank(process.env.GCP_WORKLOAD_IDENTITY_POOL_ID);
}

function vertexWorkloadIdentityProviderId(): string | undefined {
  return nonBlank(process.env.GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID);
}

function vertexFallbackClientEmail(): string | undefined {
  return nonBlank(process.env.GOOGLE_CLIENT_EMAIL);
}

function vertexPrivateKey(): string | undefined {
  return nonBlank(process.env.GOOGLE_PRIVATE_KEY)?.replace(/\\n/g, "\n");
}

function anthropicApiKey(): string | undefined {
  return nonBlank(process.env.ANTHROPIC_API_KEY);
}

function hasVertexOidcConfiguration(): boolean {
  return Boolean(
    vertexProject() &&
    vertexLocation() &&
    vertexProjectNumber() &&
    vertexServiceAccountEmail() &&
    vertexWorkloadIdentityPoolId() &&
    vertexWorkloadIdentityProviderId(),
  );
}

function hasVertexServiceAccountConfiguration(): boolean {
  return Boolean(
    vertexProject() &&
    vertexLocation() &&
    vertexFallbackClientEmail() &&
    vertexPrivateKey(),
  );
}

function hasVertexConfiguration(): boolean {
  return hasVertexOidcConfiguration() || hasVertexServiceAccountConfiguration();
}

function hasProviderConfiguration(modelId: string): boolean {
  return isGoogleModel(modelId)
    ? hasVertexConfiguration()
    : Boolean(anthropicApiKey());
}

/**
 * A self-host admin's next step when the agent is not configured, naming the
 * setting that is missing. Never includes secret values.
 */
export function agentSetupHint(): string | null {
  const modelId = activeModelId();
  if (hasProviderConfiguration(modelId)) return null;
  if (isGoogleModel(modelId)) {
    return anthropicApiKey()
      ? `The model is set to ${modelId} (Gemini), but Google Vertex AI is not configured. Set AI_MODEL to a Claude model (e.g. ${DEFAULT_CLAUDE_MODEL}) to use your Anthropic key, or configure Vertex AI.`
      : "No AI provider is configured. Set ANTHROPIC_API_KEY (a Claude model is then used by default), or configure Google Vertex AI for Gemini.";
  }
  return `The model is set to ${modelId} (Claude), but ANTHROPIC_API_KEY is not set.`;
}

/** Whether the configured provider has a complete authentication boundary. */
export function isAgentConfigured(): boolean {
  return hasProviderConfiguration(activeModelId());
}

/**
 * Resolve the configured AI SDK model instance for one-shot generations
 * (e.g. SOAP drafts) that share the agent's provider/model configuration.
 * Throws AgentNotConfiguredError when no provider authentication is set.
 */
export function configuredModel(): LanguageModel {
  const modelId = activeModelId();
  if (!hasProviderConfiguration(modelId)) throw new AgentNotConfiguredError();
  return resolveModel(modelId);
}

/** Build an AI SDK model instance for the given model id. */
function resolveModel(modelId: string) {
  if (isGoogleModel(modelId)) {
    const googleAuthOptions = hasVertexOidcConfiguration()
      ? vertexOidcAuthOptions()
      : {
          credentials: {
            client_email: vertexFallbackClientEmail(),
            private_key: vertexPrivateKey(),
          },
        };
    const vertex = createVertex({
      project: vertexProject(),
      location: vertexLocation(),
      googleAuthOptions,
    });
    return vertex(modelId.replace(/^(google\/|models\/)/, ""));
  }
  const anthropic = createAnthropic({ apiKey: anthropicApiKey() });
  return anthropic(modelId.replace(/^anthropic\//, ""));
}

function vertexOidcAuthOptions() {
  const serviceAccountEmail = vertexServiceAccountEmail();
  const authClient = ExternalAccountClient.fromJSON({
    type: "external_account",
    audience: `//iam.googleapis.com/projects/${vertexProjectNumber()}/locations/global/workloadIdentityPools/${vertexWorkloadIdentityPoolId()}/providers/${vertexWorkloadIdentityProviderId()}`,
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    token_url: "https://sts.googleapis.com/v1/token",
    service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${serviceAccountEmail}:generateAccessToken`,
    subject_token_supplier: {
      getSubjectToken: async () => getVercelOidcToken(),
    },
  });
  if (!authClient) throw new AgentNotConfiguredError();
  return { authClient, projectId: vertexProject() };
}

function retryAfterSeconds(resetAt: Date): number {
  return Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000));
}

function hasApiScope(scopes: string[], required: string): boolean {
  return scopes.includes("*") || scopes.includes(required);
}

function missingToolApiScopes(
  toolDef: AgentTool,
  apiKeyScopes: string[] | undefined,
): string[] {
  if (!apiKeyScopes) return [];
  return (toolDef.requiredApiScopes ?? []).filter(
    (scope) => !hasApiScope(apiKeyScopes, scope),
  );
}

async function enforceAgentRunRateLimitBucket(input: {
  key: string;
  limit: number;
  logContext: string;
}): Promise<void> {
  let result: Awaited<ReturnType<typeof rateLimit>>;
  try {
    result = await rateLimit({
      key: input.key,
      limit: input.limit,
      windowMs: AGENT_RUN_RATE_WINDOW_MS,
    });
  } catch (err) {
    console.error(`[agent.${input.logContext}] rate limit failed:`, err);
    const resetAt = new Date(Date.now() + AGENT_RUN_RATE_WINDOW_MS);
    throw new AgentRateLimitedError(
      retryAfterSeconds(resetAt),
      input.limit,
      resetAt,
    );
  }

  if (!result.success) {
    throw new AgentRateLimitedError(
      retryAfterSeconds(result.resetAt),
      input.limit,
      result.resetAt,
    );
  }
}

async function enforceAgentRunRateLimit(ctx: AgentToolContext): Promise<void> {
  await enforceAgentRunRateLimitBucket({
    key: `agent-run:${ctx.practiceId}:actor:${ctx.userId}`,
    limit: AGENT_RUN_ACTOR_RATE_LIMIT,
    logContext: "actor",
  });

  await enforceAgentRunRateLimitBucket({
    key: `agent-run:${ctx.practiceId}:practice`,
    limit: AGENT_RUN_PRACTICE_RATE_LIMIT,
    logContext: "practice",
  });
}

/**
 * Build the AI SDK tool set from AGENT_TOOLS. Write tools are gated behind
 * `allowWrites`; every call (and any error) is captured into `sink` so the
 * caller can report exactly what the agent did, mirroring the prior runner.
 */
function buildToolSet(
  ctx: AgentToolContext,
  allowWrites: boolean,
  apiKeyScopes: string[] | undefined,
  sink: AgentToolCall[],
): ToolSet {
  const entries = AGENT_TOOLS.filter(
    (t) => !t.requiresStaffUser || Boolean(ctx.staffUser),
  ).map(
    (t) =>
      [
        t.name,
        tool({
          description: t.description,
          inputSchema: t.zod,
          execute: async (args: unknown) => {
            const call: AgentToolCall = { name: t.name, input: args };
            try {
              if (!t.readOnly && !allowWrites) {
                call.error = WRITES_DISABLED_ERROR;
              } else {
                const missingScopes = missingToolApiScopes(t, apiKeyScopes);
                if (missingScopes.length > 0) {
                  call.error = `Tool requires API key scope${
                    missingScopes.length === 1 ? "" : "s"
                  }: ${missingScopes.join(", ")}.`;
                } else {
                  call.result = await t.execute(args, ctx);
                }
              }
            } catch (e) {
              if (e instanceof AgentPracticeNotFoundError) {
                throw e;
              }
              call.error =
                e instanceof Error ? e.message : "Tool execution failed";
            }
            sink.push(call);
            return call.error ? { error: call.error } : call.result;
          },
        }),
      ] as const,
  );
  return Object.fromEntries(entries) as ToolSet;
}

/**
 * Run the OpenVPM Agent against a natural-language instruction. Executes a
 * tool-use loop scoped to the caller's practice. Write tools are gated behind
 * `allowWrites` (default false) so a read-only run can never mutate data.
 */
export async function runAgent(opts: {
  instruction: string;
  context: AgentToolContext;
  allowWrites?: boolean;
  apiKeyScopes?: string[];
  model?: string;
  /** Prior conversation turns, oldest first, for multi-turn chat context. */
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  /** What the clinician is looking at in the app, for "this patient". */
  hints?: AgentRunContextHints;
}): Promise<AgentRunResult> {
  const modelId = activeModelId(opts.model);
  if (!hasProviderConfiguration(modelId)) throw new AgentNotConfiguredError();
  if (
    !(await lockPracticeForExternalSideEffects(
      opts.context.db,
      opts.context.practiceId,
    ))
  ) {
    throw new AgentRecoveryHoldError();
  }

  // Re-read entitlement only after taking the practice share lock that remains
  // held through the provider call. A concurrent Stripe lifecycle update must
  // therefore commit before this decision or wait until no Gemini call can be
  // started under the old state.
  const aiAccess = await readHostedAiAccess(
    opts.context.db,
    opts.context.practiceId,
  );
  if (!aiAccess) throw new AgentPracticeNotFoundError();
  if (!aiAccess.allowed) {
    throw new AgentBillingAccessError(
      aiAccess.message ?? "OpenVPM AI is not available.",
    );
  }

  const allowWrites = opts.allowWrites ?? false;
  await enforceAgentRunRateLimit(opts.context);

  const toolCalls: AgentToolCall[] = [];
  const system = `${SYSTEM_PROMPT}\n\n${buildRunContextPrompt({
    now: new Date(),
    timeZone: await practiceTimeZone(opts.context),
    staffUser: opts.context.staffUser,
    hints: opts.hints,
  })}`;
  // A conversation (with history) uses `messages`; a one-shot run uses `prompt`.
  const messagesInput =
    opts.history && opts.history.length > 0
      ? {
          messages: [
            ...opts.history.map((m) => ({ role: m.role, content: m.content })),
            { role: "user" as const, content: opts.instruction },
          ],
        }
      : { prompt: opts.instruction };
  const result = await generateText({
    model: resolveModel(modelId),
    system,
    ...messagesInput,
    tools: buildToolSet(
      opts.context,
      allowWrites,
      opts.apiKeyScopes,
      toolCalls,
    ),
    stopWhen: stepCountIs(MAX_ITERATIONS),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });

  // Meter only successful agent runs for hosted billing (no-op on self-host).
  await recordUsage({ practiceId: opts.context.practiceId, kind: "ai_run" });

  return {
    text: result.text.trim(),
    toolCalls,
    iterations: result.steps.length,
    stopReason: result.finishReason ?? null,
  };
}

/** Names of tools the agent can use, for surfacing in the UI/docs. */
export const AGENT_TOOL_NAMES = AGENT_TOOLS.map((t) => t.name);
