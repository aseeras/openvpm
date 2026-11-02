"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowUp,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  CreditCard,
  Wrench,
  Loader2,
  Sparkles,
  ShieldCheck,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  emitGuideSignal,
  GUIDE_SIGNALS,
} from "@/components/tour/guide-signals";
import {
  AGENT_INSTRUCTION_MAX_LENGTH,
  isAgentInstructionValid,
} from "@/lib/agent/policy";
import { AgentMessageText } from "./agent-message-text";
import { DictationButton } from "./dictation-button";

export const WRITES_DISABLED_ERROR = "Write tools are disabled for this run.";

const DEFAULT_SUGGESTIONS = [
  "What does my day look like?",
  "What needs my attention?",
  "Which patients are overdue for vaccinations?",
  "What's the carprofen dose for a 12 kg dog?",
];

const PATIENT_SUGGESTIONS = [
  "Summarize this patient's history.",
  "What medications is this pet on, and can they be refilled?",
  "When was this pet's last bloodwork, and what did it show?",
];

const VISIT_SUGGESTIONS = [
  "Brief me on this visit.",
  "Draft the SOAP note from my notes: ",
];

type ToolCall = { name: string; input: unknown; error?: string | null };
type ChatMessage = {
  id: number;
  role: "user" | "assistant";
  content: string;
  toolCalls?: ToolCall[];
  isError?: boolean;
  /** The instruction that produced this reply, for "allow and retry". */
  sourceInstruction?: string;
};

export interface AgentChatHints {
  patientId?: string;
  appointmentId?: string;
}

/** True when the run tried a write tool that the run did not allow. */
export function replyNeedsWriteApproval(toolCalls?: ToolCall[]): boolean {
  return Boolean(toolCalls?.some((call) => call.error === WRITES_DISABLED_ERROR));
}

export function AgentChat({
  isAdmin,
  variant = "page",
  hints,
  initialInstruction,
  autoSend = false,
  onNavigate,
}: {
  isAdmin: boolean;
  variant?: "page" | "panel";
  hints?: AgentChatHints;
  initialInstruction?: string;
  /** Send initialInstruction as soon as the agent is ready (read-only run). */
  autoSend?: boolean;
  /** Called when the user follows an in-app link from a reply. */
  onNavigate?: () => void;
}) {
  const router = useRouter();
  const status = trpc.agent.status.useQuery();
  const run = trpc.agent.run.useMutation();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [instruction, setInstruction] = useState(initialInstruction ?? "");
  const [allowWrites, setAllowWrites] = useState(false);
  const idRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isPage = variant === "page";

  useEffect(() => {
    if (initialInstruction) {
      setInstruction(initialInstruction);
      textareaRef.current?.focus();
    }
  }, [initialInstruction]);

  const autoSent = useRef(false);

  const statusMissing = !status.isLoading && !status.error && !status.data;
  const verifiedAgentStatus =
    status.error || statusMissing || !status.data ? null : status.data;
  const configured = verifiedAgentStatus
    ? verifiedAgentStatus.configured
    : false;
  const canUseAi = verifiedAgentStatus?.canUseAi ?? false;
  const needsBillingSetup = verifiedAgentStatus?.needsBillingSetup ?? false;
  const canRun = !status.isLoading && configured && canUseAi;
  const instructionInvalid =
    instruction.length > 0 && !isAgentInstructionValid(instruction);
  const submitDisabled =
    !canRun || !isAgentInstructionValid(instruction) || run.isPending;
  const hasConversation = messages.length > 0;
  const lastReplyId = [...messages]
    .reverse()
    .find((m) => m.role === "assistant" && !m.isError)?.id;
  const suggestions = hints?.appointmentId
    ? [...VISIT_SUGGESTIONS, ...PATIENT_SUGGESTIONS.slice(0, 2)]
    : hints?.patientId
      ? [...PATIENT_SUGGESTIONS, DEFAULT_SUGGESTIONS[0]!]
      : DEFAULT_SUGGESTIONS;

  // Signal the tour AFTER the reply is committed to the DOM so its next step
  // can spotlight the answer.
  const signaledReplyId = useRef<number | null>(null);
  useEffect(() => {
    if (!isPage) return;
    if (lastReplyId == null || signaledReplyId.current === lastReplyId) return;
    signaledReplyId.current = lastReplyId;
    emitGuideSignal(GUIDE_SIGNALS.agentRunSucceeded);
  }, [lastReplyId, isPage]);

  useEffect(() => {
    if (!canRun && allowWrites) {
      setAllowWrites(false);
    }
  }, [allowWrites, canRun]);

  // Siri Shortcut deep link: send the prefilled question once, without
  // changes allowed. Anything that would change data still asks first.
  useEffect(() => {
    if (!autoSend || autoSent.current || !canRun || run.isPending) return;
    const text = initialInstruction?.trim();
    if (!text || !isAgentInstructionValid(text)) return;
    autoSent.current = true;
    setInstruction("");
    send(text, false);
    // send() is stable for this purpose; only readiness should retrigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSend, canRun, initialInstruction]);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, run.isPending]);

  function nextId() {
    idRef.current += 1;
    return idRef.current;
  }

  function send(text: string, writes: boolean, opts?: { echo?: boolean }) {
    // Send a trailing window of the conversation for multi-turn context.
    const history = messages
      .filter((m) => !m.isError)
      .slice(-12)
      .map((m) => ({ role: m.role, content: m.content }));
    if (opts?.echo !== false) {
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: "user", content: text },
      ]);
    }
    run.mutate(
      {
        instruction: text,
        allowWrites: writes,
        history: history.length > 0 ? history : undefined,
        context:
          hints?.patientId || hints?.appointmentId
            ? { patientId: hints.patientId, appointmentId: hints.appointmentId }
            : undefined,
      },
      {
        onSuccess: (data) => {
          setMessages((prev) => [
            ...prev,
            {
              id: nextId(),
              role: "assistant",
              content: data.text,
              toolCalls: data.toolCalls,
              sourceInstruction: text,
            },
          ]);
        },
        onError: (err) => {
          setMessages((prev) => [
            ...prev,
            {
              id: nextId(),
              role: "assistant",
              content: err.message,
              isError: true,
            },
          ]);
        },
        onSettled: () => setAllowWrites(false),
      },
    );
  }

  function submit() {
    if (submitDisabled) return;
    const text = instruction.trim();
    setInstruction("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    send(text, allowWrites);
  }

  function approveAndRetry(message: ChatMessage) {
    if (!canRun || run.isPending || !message.sourceInstruction) return;
    const text = `Yes, go ahead and make that change. (Original request: ${message.sourceInstruction})`.slice(
      0,
      AGENT_INSTRUCTION_MAX_LENGTH,
    );
    setMessages((prev) => [
      ...prev,
      { id: nextId(), role: "user", content: "Allowed the change." },
    ]);
    send(text, true, { echo: false });
  }

  function pickSuggestion(text: string) {
    setInstruction(text);
    textareaRef.current?.focus();
  }

  function appendDictation(text: string) {
    setInstruction((prev) => {
      const joined = prev.trim() ? `${prev.trimEnd()} ${text}` : text;
      return joined.slice(0, AGENT_INSTRUCTION_MAX_LENGTH);
    });
  }

  const statusBanner = status.isLoading ? (
    <div className="mb-4 flex items-center gap-2 rounded-lg border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      Checking agent configuration…
    </div>
  ) : status.error ? (
    <div className="mb-4 flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div>
        <p className="font-medium">Could not check agent status</p>
        <p className="mt-1">{status.error.message}</p>
        <Button
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={() => void status.refetch()}
        >
          Retry
        </Button>
      </div>
    </div>
  ) : statusMissing ? (
    <div className="mb-4 flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div>
        <p className="font-medium">Agent status is unavailable</p>
        <p className="mt-1">
          We could not confirm the agent is ready. Retry before running.
        </p>
        <Button
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={() => void status.refetch()}
        >
          Retry
        </Button>
      </div>
    </div>
  ) : needsBillingSetup ? (
    <div className="mb-4 flex items-start gap-3 rounded-lg border border-primary/20 bg-primary/5 p-4 text-sm">
      <CreditCard className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
      <div>
        <p className="font-medium">Add a card to try AI</p>
        <p className="mt-1 text-muted-foreground">
          {verifiedAgentStatus?.accessMessage}
        </p>
        {isAdmin ? (
          <Button
            size="sm"
            className="mt-3"
            onClick={() => router.push("/settings?tab=billing")}
          >
            Add a card
          </Button>
        ) : (
          <p className="mt-2 text-muted-foreground">
            Ask a practice administrator to add the card.
          </p>
        )}
      </div>
    </div>
  ) : !canUseAi ? (
    <div className="mb-4 flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <p>
        {verifiedAgentStatus?.accessMessage ??
          "OpenVPM AI is not available for this workspace."}
      </p>
    </div>
  ) : !configured ? (
    <div className="mb-4 flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      {verifiedAgentStatus?.hosted ? (
        <p>
          The agent is not available right now. We are on it. Please check back
          soon.
        </p>
      ) : verifiedAgentStatus?.setupHint ? (
        <p>{verifiedAgentStatus.setupHint}</p>
      ) : (
        <p>
          Configure Google Vertex AI with{" "}
          <code className="break-all font-mono">GOOGLE_VERTEX_PROJECT</code>,{" "}
          <code className="break-all font-mono">GOOGLE_VERTEX_LOCATION</code>,{" "}
          and service-account credentials for Gemini, or set{" "}
          <code className="break-all font-mono">ANTHROPIC_API_KEY</code> for an
          explicit Claude model.
        </p>
      )}
    </div>
  ) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {statusBanner}

      {/* Conversation */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        {!hasConversation ? (
          <div className="flex h-full flex-col items-center justify-center px-4 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <Sparkles className="h-6 w-6" />
            </div>
            <h2 className="mt-4 font-heading text-xl font-semibold">
              What can I help you with?
            </h2>
            <p className="mt-1 max-w-md text-sm text-muted-foreground">
              Ask in plain words, type or tap the mic. I can read the chart and
              your schedule, and draft notes for you to review and sign.
            </p>
            <div
              className={cn(
                "mt-6 grid w-full gap-2",
                isPage ? "max-w-xl sm:grid-cols-2" : "max-w-md",
              )}
            >
              {suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => pickSuggestion(s)}
                  disabled={!canRun}
                  className="rounded-xl border border-border bg-card p-3 text-left text-sm text-foreground transition-colors hover:border-primary/40 hover:bg-accent/40 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-4 pb-2">
            {messages.map((m) => {
              const bubble = (
                <MessageBubble
                  message={m}
                  onNavigate={onNavigate}
                  onApprove={
                    !m.isError &&
                    m.id === lastReplyId &&
                    replyNeedsWriteApproval(m.toolCalls)
                      ? () => approveAndRetry(m)
                      : undefined
                  }
                  approveDisabled={!canRun || run.isPending}
                />
              );
              return isPage && m.id === lastReplyId ? (
                // The tour's reply beat spotlights the newest good answer.
                <div key={m.id} data-tour="agent-reply">
                  {bubble}
                </div>
              ) : (
                <div key={m.id}>{bubble}</div>
              );
            })}
            {run.isPending ? <TypingIndicator /> : null}
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="mt-3 shrink-0">
        <div
          // The launcher never renders on /agent, so this anchor stays unique.
          data-tour="agent-input"
          className="rounded-2xl border border-border bg-card p-2 shadow-sm focus-within:border-primary/40"
        >
          <textarea
            ref={textareaRef}
            value={instruction}
            onChange={(e) => {
              setInstruction(e.target.value);
              const el = e.target;
              el.style.height = "auto";
              el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={isPage ? 1 : 2}
            maxLength={AGENT_INSTRUCTION_MAX_LENGTH}
            aria-label="Ask the assistant"
            aria-invalid={instructionInvalid || undefined}
            disabled={!canRun || run.isPending}
            placeholder={
              canRun
                ? "Ask anything, or dictate visit notes…"
                : needsBillingSetup
                  ? "Add a card to try AI."
                  : "The agent is not available right now."
            }
            className="max-h-40 w-full resize-none bg-transparent px-3 py-2 text-base outline-none placeholder:text-muted-foreground sm:text-sm"
          />
          <div className="flex items-center justify-between gap-3 px-1">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={allowWrites}
                onChange={(e) => setAllowWrites(e.target.checked)}
                disabled={!canRun || run.isPending}
                className="h-3.5 w-3.5 rounded border-border"
              />
              Allow changes
            </label>
            <div className="flex items-center gap-2">
              <DictationButton
                disabled={!canRun || run.isPending}
                onText={appendDictation}
              />
              <Button
                type="button"
                size="icon"
                onClick={submit}
                disabled={submitDisabled}
                aria-label="Send"
                className="h-8 w-8 rounded-full"
              >
                {run.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ArrowUp className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>
        </div>
        {allowWrites ? (
          <div className="mt-2 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <p>
              Changes are on for your next message: booking visits, recording
              vitals, and saving SOAP drafts (never finalized). It turns off
              after that message.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  onNavigate,
  onApprove,
  approveDisabled,
}: {
  message: ChatMessage;
  onNavigate?: () => void;
  onApprove?: () => void;
  approveDisabled?: boolean;
}) {
  const [traceOpen, setTraceOpen] = useState(false);
  const isUser = message.role === "user";

  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[90%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed",
          isUser
            ? "bg-primary text-primary-foreground"
            : message.isError
              ? "border border-destructive/30 bg-destructive/5 text-destructive"
              : "bg-muted text-foreground",
        )}
      >
        {isUser || message.isError ? (
          <div className="whitespace-pre-wrap">{message.content}</div>
        ) : (
          <AgentMessageText text={message.content} onNavigate={onNavigate} />
        )}

        {onApprove ? (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 p-2">
            <ShieldCheck className="h-4 w-4 shrink-0 text-primary" />
            <span className="text-xs text-muted-foreground">
              This needs your okay to save.
            </span>
            <Button
              type="button"
              size="sm"
              onClick={onApprove}
              disabled={approveDisabled}
              className="ml-auto h-7"
            >
              Allow this change
            </Button>
          </div>
        ) : null}

        {message.toolCalls && message.toolCalls.length > 0 ? (
          <div className="mt-3 border-t border-border/60 pt-2">
            <button
              type="button"
              onClick={() => setTraceOpen((o) => !o)}
              className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              {traceOpen ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
              <Wrench className="h-3.5 w-3.5" />
              {message.toolCalls.length} tool call
              {message.toolCalls.length === 1 ? "" : "s"}
            </button>
            {traceOpen ? (
              <ul className="mt-2 space-y-2">
                {message.toolCalls.map((call, i) => (
                  <li
                    key={i}
                    className={cn(
                      "rounded-md border p-2 font-mono text-xs",
                      call.error
                        ? "border-destructive/30 bg-destructive/5 text-destructive"
                        : "border-border bg-surface text-muted-foreground",
                    )}
                  >
                    <div className="font-semibold text-foreground">
                      {call.name}
                    </div>
                    <div className="mt-1 break-all">
                      {JSON.stringify(call.input)}
                    </div>
                    {call.error ? (
                      <div className="mt-1">⚠ {call.error}</div>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="flex justify-start">
      <div className="flex items-center gap-1.5 rounded-2xl bg-muted px-4 py-3">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground/60"
            style={{ animationDelay: `${i * 0.15}s` }}
          />
        ))}
      </div>
    </div>
  );
}
