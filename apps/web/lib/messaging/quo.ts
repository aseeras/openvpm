import type {
  MessagingProvider,
  SendMessageInput,
  SendMessageResult,
} from "./types";
import { cleanSender, envValue } from "./env";

/**
 * Quo (formerly OpenPhone) adapter. Quo is a business phone service: the
 * clinic's own Quo number sends the text, and the same conversation stays
 * visible in the Quo apps. Carrier (A2P 10DLC) registration is done inside the
 * clinic's Quo workspace, not by OpenVPM.
 *
 * Sender: `messagingServiceId` holds the Quo phone number id (`PN…`), and
 * `from` holds the E.164 number. Quo accepts either as `from`.
 */
export const QUO_API_BASE_URL = "https://api.quo.com";
const QUO_SEND_TIMEOUT_MS = 15_000;

function quoApiBaseUrl(): string {
  return (envValue("QUO_API_BASE_URL") ?? QUO_API_BASE_URL).replace(/\/+$/, "");
}

function quoErrorMessage(status: number, payload: unknown): string {
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const parts = [record.title, record.message, record.code]
      .filter((part): part is string => typeof part === "string" && !!part)
      .map((part) => part.trim());
    if (parts.length > 0) return `Quo ${status}: ${parts.join(" · ")}`;
  }
  return `Quo request failed with HTTP ${status}.`;
}

/** 4xx (except timeouts and rate limits) means Quo refused the message. */
function quoHttpFailure(status: number, payload: unknown): SendMessageResult {
  const error = quoErrorMessage(status, payload);
  return status >= 400 && status < 500 && status !== 408 && status !== 429
    ? { status: "definite_failure", error }
    : { status: "outcome_unknown", error };
}

export const quoProvider: MessagingProvider = {
  name: "quo",

  isConfigured(): boolean {
    return Boolean(envValue("QUO_API_KEY"));
  },

  async send({
    to,
    body,
    sender,
  }: SendMessageInput): Promise<SendMessageResult> {
    const apiKey = envValue("QUO_API_KEY");
    if (!apiKey) {
      return { status: "definite_failure", error: "Quo is not configured." };
    }
    const configuredSender = cleanSender(sender);
    const from = configuredSender.messagingServiceId ?? configuredSender.from;
    if (!from) {
      return {
        status: "definite_failure",
        error: "No Quo sender (phone number id or number) configured.",
      };
    }

    let response: Response;
    try {
      response = await fetch(`${quoApiBaseUrl()}/v1/messages`, {
        method: "POST",
        headers: {
          // Quo takes the raw API key, not a Bearer token.
          Authorization: apiKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ content: body, from, to: [to] }),
        signal: AbortSignal.timeout(QUO_SEND_TIMEOUT_MS),
      });
    } catch (err) {
      // Network errors and timeouts may still have reached Quo.
      return {
        status: "outcome_unknown",
        error: err instanceof Error ? err.message : "Quo request failed.",
      };
    }

    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) return quoHttpFailure(response.status, payload);

    const data =
      payload && typeof payload === "object"
        ? (payload as { data?: { id?: unknown } }).data
        : undefined;
    const id = typeof data?.id === "string" ? data.id.trim() : "";
    return id
      ? { status: "accepted", id }
      : {
          status: "outcome_unknown",
          error: "Quo accepted the request but returned no message id.",
        };
  },
};
