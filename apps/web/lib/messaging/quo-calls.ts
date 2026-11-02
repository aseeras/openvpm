import { and, isNull, eq } from "drizzle-orm";
import {
  clients,
  communications,
  smsSendAttemptEvents,
  smsSendAttempts,
} from "@openpims/db";
import { db, type Database } from "@openpims/db/client";
import { latestAssignedToForClient } from "@/lib/communications/assignment";
import { withSystem } from "@/lib/tenant-db";
import {
  findMessagingLocationCandidatesForWebhookInTransaction,
  normalizedClientPhoneCondition,
} from "./inbound";
import { normalizeE164 } from "./phone";

/**
 * Quo call activity, normalized from a signed `call.completed`,
 * `call.voicemail.completed`, or `call.summary.completed` webhook. Calls are logged to the Communications
 * inbox as `phone` entries so staff see them next to texts and portal
 * messages, linked to the client when exactly one client has that number.
 */
export type QuoCallActivity =
  | {
      kind: "call";
      callId: string;
      phoneNumberId: string;
      direction: "inbound" | "outbound";
      externalPhone: string;
      status: string | null;
      durationSeconds: number | null;
      hasVoicemail: boolean;
      occurredAt: Date;
      quoLink: string | null;
    }
  | {
      kind: "voicemail";
      voicemailId: string;
      phoneNumberId: string;
      externalPhone: string;
      durationSeconds: number | null;
      transcript: string | null;
      occurredAt: Date;
      quoLink: string | null;
    }
  | {
      /** Quo's call summary, including what callers told Quo's AI agent. */
      kind: "summary";
      callId: string;
      phoneNumberId: string;
      externalPhone: string;
      handledByAiAgent: boolean;
      summary: string[];
      nextSteps: string[];
      /** Details the AI agent collected, e.g. caller name or pet name. */
      details: Array<{ name: string; value: string }>;
      occurredAt: Date;
      quoLink: string | null;
    };

const MAX_TRANSCRIPT_LENGTH = 4_000;

function formatPhone(e164: string): string {
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : e164;
}

function formatDuration(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  const whole = Math.round(seconds);
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

const CALL_STATUS_LABELS: Record<string, string> = {
  answered: "answered",
  unanswered: "missed",
  abandoned: "missed (caller hung up)",
  forwarded: "forwarded",
  failed: "failed",
  "ai-handled": "answered by Quo's AI agent",
};

/** Subject and body for the inbox entry. Pure, so it is easy to test. */
export function describeQuoCallActivity(activity: QuoCallActivity): {
  subject: string;
  content: string;
} {
  const phone = formatPhone(activity.externalPhone);
  const duration = formatDuration(
    "durationSeconds" in activity ? activity.durationSeconds : null,
  );
  const link = activity.quoLink ? `\n\nOpen in Quo: ${activity.quoLink}` : "";

  if (activity.kind === "voicemail") {
    const transcript = activity.transcript
      ?.trim()
      .slice(0, MAX_TRANSCRIPT_LENGTH);
    return {
      subject: `Voicemail from ${phone}`,
      content:
        (transcript
          ? `Voicemail${duration ? ` (${duration})` : ""}: "${transcript}"`
          : `Voicemail${duration ? ` (${duration})` : ""}. No transcript yet; listen in Quo.`) +
        link,
    };
  }

  if (activity.kind === "summary") {
    const lines = [
      ...activity.details.map((detail) => `${detail.name}: ${detail.value}`),
      ...(activity.summary.length > 0
        ? ["", "Summary:", ...activity.summary.map((line) => `- ${line}`)]
        : []),
      ...(activity.nextSteps.length > 0
        ? ["", "Next steps:", ...activity.nextSteps.map((line) => `- ${line}`)]
        : []),
    ];
    return {
      subject: `${activity.handledByAiAgent ? "AI agent call notes" : "Call summary"}: ${phone}`,
      content: lines.join("\n").trim().slice(0, MAX_TRANSCRIPT_LENGTH) + link,
    };
  }

  const status = activity.status ? CALL_STATUS_LABELS[activity.status] : null;
  if (activity.direction === "outbound") {
    return {
      subject: `Call to ${phone}`,
      content:
        [
          `Outgoing call${status ? `: ${status}` : ""}`,
          duration ? `${duration} long` : null,
        ]
          .filter(Boolean)
          .join(", ") + `.${link}`,
    };
  }
  const missed =
    activity.status !== "answered" && activity.status !== "ai-handled";
  return {
    subject: `${missed ? "Missed call" : "Call"} from ${phone}`,
    content:
      [
        `Incoming call${status ? `: ${status}` : ""}`,
        duration && !missed ? `${duration} long` : null,
        activity.hasVoicemail ? "caller left a voicemail" : null,
      ]
        .filter(Boolean)
        .join(", ") + `.${link}`,
  };
}

export function quoCallDedupeKey(activity: QuoCallActivity): string {
  if (activity.kind === "voicemail") {
    return `quo:voicemail:${activity.voicemailId}`.slice(0, 160);
  }
  if (activity.kind === "summary") {
    return `quo:summary:${activity.callId}`.slice(0, 160);
  }
  return `quo:call:${activity.callId}`.slice(0, 160);
}

async function logQuoCallActivityInTransaction(
  tx: Database,
  activity: QuoCallActivity,
): Promise<"logged" | "duplicate" | "unrouted"> {
  const externalPhone = normalizeE164(activity.externalPhone);
  if (!externalPhone) return "unrouted";

  const candidates =
    await findMessagingLocationCandidatesForWebhookInTransaction(tx, {
      provider: "quo",
      messagingProfileId: activity.phoneNumberId,
    });
  const practiceId = candidates.location?.practiceId;
  if (!practiceId) return "unrouted";

  const phoneCondition = normalizedClientPhoneCondition(externalPhone);
  const matches = phoneCondition
    ? await tx
        .select({ id: clients.id })
        .from(clients)
        .where(
          and(
            eq(clients.practiceId, practiceId),
            isNull(clients.deletedAt),
            phoneCondition,
          ),
        )
        .limit(2)
    : [];
  const clientId = matches.length === 1 ? (matches[0]?.id ?? null) : null;

  const { subject, content } = describeQuoCallActivity({
    ...activity,
    externalPhone,
  });
  const direction =
    activity.kind === "call" ? activity.direction : ("inbound" as const);
  const providerId =
    activity.kind === "voicemail" ? activity.voicemailId : activity.callId;

  const inserted = await tx
    .insert(communications)
    .values({
      practiceId,
      clientId: clientId ?? undefined,
      channel: "phone",
      direction,
      subject,
      content,
      // Inbound entries stay unread so staff can follow up; calls the clinic
      // placed are a record only.
      status: direction === "inbound" ? "delivered" : "sent",
      createdAt: activity.occurredAt,
      providerMessageId: providerId,
      dedupeKey: quoCallDedupeKey(activity),
      ...(clientId
        ? { assignedTo: latestAssignedToForClient(practiceId, clientId) }
        : {}),
    })
    .onConflictDoNothing({ target: communications.dedupeKey })
    .returning({ id: communications.id });
  return inserted.length > 0 ? "logged" : "duplicate";
}

export async function logQuoCallActivity(
  activity: QuoCallActivity,
): Promise<"logged" | "duplicate" | "unrouted"> {
  return withSystem(db, (tx) => logQuoCallActivityInTransaction(tx, activity));
}

/**
 * True when OpenVPM itself sent this Quo message id. Quo also reports delivery
 * for texts staff send from the Quo apps; those have no OpenVPM send attempt
 * and are ignored instead of waiting forever in the delivery ledger.
 */
export async function openVpmSentThroughQuo(providerMessageId: string) {
  const rows = await withSystem(db, (tx) =>
    tx
      .select({ id: smsSendAttempts.id })
      .from(smsSendAttempts)
      .innerJoin(
        smsSendAttemptEvents,
        and(
          eq(smsSendAttemptEvents.practiceId, smsSendAttempts.practiceId),
          eq(smsSendAttemptEvents.attemptId, smsSendAttempts.id),
        ),
      )
      .where(
        and(
          eq(smsSendAttempts.provider, "quo"),
          eq(smsSendAttemptEvents.outcome, "accepted"),
          eq(smsSendAttemptEvents.providerMessageId, providerMessageId),
        ),
      )
      .limit(1),
  );
  return rows.length > 0;
}
