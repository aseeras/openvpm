import { NextResponse } from "next/server";
import { readRequestTextWithLimit } from "@/lib/request-json";
import {
  MESSAGING_WEBHOOK_BODY_MAX_BYTES,
  messagingWebhookContentLengthTooLarge,
} from "@/lib/messaging-webhook-limits";
import { normalizeE164 } from "@/lib/messaging";
import { envValue } from "@/lib/messaging/env";
import { classifyInboundSms } from "@/lib/messaging/inbound";
import {
  logQuoCallActivity,
  openVpmSentThroughQuo,
} from "@/lib/messaging/quo-calls";
import { verifyQuoWebhook } from "@/lib/messaging/quo-signature";
import {
  ingestSmsProviderEvent,
  projectSmsProviderEvent,
} from "@/lib/messaging/sms-provider-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Quo (formerly OpenPhone) webhook, API version 2026-03-30.
 *
 * - message.received → inbound SMS (Communications inbox, STOP/START handling)
 * - message.delivered / failed / undelivered → delivery status of texts that
 *   OpenVPM sent through Quo (texts staff send from the Quo app are ignored)
 * - call.completed / call.voicemail.completed → a phone entry in the inbox
 */

const DELIVERY_EVENTS = new Set([
  "message.delivered",
  "message.failed",
  "message.undelivered",
]);

type Json = Record<string, unknown>;

function record(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function str(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function firstString(value: unknown): string | null {
  return Array.isArray(value) ? str(value[0]) : null;
}

function date(value: unknown): Date {
  const raw = str(value);
  const parsed = raw ? new Date(raw) : new Date();
  return Number.isFinite(parsed.getTime()) ? parsed : new Date();
}

/** Provider ids and status tokens must fit the ledger's safe-token rules. */
function token(value: unknown): string | null {
  const raw = str(value);
  if (!raw) return null;
  const normalized = raw.replace(/[^A-Za-z0-9_.:-]+/g, "_").slice(0, 80);
  return normalized || null;
}

function ok() {
  return NextResponse.json({ ok: true });
}

function badRequest(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}

function deliveryClassification(eventType: string) {
  if (eventType === "message.delivered") return "delivered" as const;
  return "failed" as const;
}

export async function POST(request: Request) {
  if (messagingWebhookContentLengthTooLarge(request.headers)) {
    return NextResponse.json(
      { error: "Messaging webhook payload too large" },
      { status: 413 },
    );
  }
  const rawBody = await readRequestTextWithLimit(
    request,
    MESSAGING_WEBHOOK_BODY_MAX_BYTES,
  );
  if (!rawBody.ok) {
    return NextResponse.json(
      { error: "Messaging webhook payload too large" },
      { status: 413 },
    );
  }

  if (
    !verifyQuoWebhook({
      secret: envValue("QUO_WEBHOOK_SECRET"),
      headers: request.headers,
      rawBody: rawBody.text,
    })
  ) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let payload: Json | null;
  try {
    payload = record(JSON.parse(rawBody.text));
  } catch {
    return badRequest("invalid JSON");
  }
  const eventType = str(payload?.type);
  const data = record(payload?.data);
  const resource = record(data?.resource);
  const context = record(data?.context);
  if (!payload || !eventType || !resource || !context) {
    return badRequest("malformed Quo event");
  }
  const eventId = token(payload.id) ?? token(request.headers.get("webhook-id"));
  const phoneNumberId = str(context.phoneNumberId);
  const quoLink = str(record(data?.links)?.quo);

  if (eventType === "message.received") {
    if (str(resource.direction) && str(resource.direction) !== "incoming") {
      return ok();
    }
    const providerMessageId = token(resource.id);
    const fromPhone = normalizeE164(str(context.senderIdentifier));
    const toPhone = normalizeE164(firstString(context.recipientIdentifiers));
    if (!providerMessageId) return badRequest("missing inbound message id");
    // Direct-number and internal Quo flows can use non-phone identifiers;
    // those are not client texts.
    if (!fromPhone) return ok();
    const hasMedia = Array.isArray(resource.media) && resource.media.length > 0;
    const text =
      str(resource.text)?.slice(0, 1_600) ??
      (hasMedia ? "(Sent a photo or attachment. Open it in Quo.)" : null);
    if (!text) return ok();

    const ingested = await ingestSmsProviderEvent({
      provider: "quo",
      kind: "inbound",
      providerEventId: eventId ?? providerMessageId,
      providerMessageId,
      providerEventType: "message.received",
      rawBody: rawBody.text,
      occurredAt: str(resource.createdAt),
      fromE164: fromPhone,
      toE164: toPhone,
      messagingProfileId: phoneNumberId,
      messageBody: text,
      inboundClassification: classifyInboundSms(text),
    });
    if (!ingested.conflict) await projectSmsProviderEvent(ingested.eventId);
    return ok();
  }

  if (DELIVERY_EVENTS.has(eventType)) {
    const providerMessageId = token(resource.id);
    if (!providerMessageId) return badRequest("missing delivery message id");
    if (!(await openVpmSentThroughQuo(providerMessageId))) return ok();
    const ingested = await ingestSmsProviderEvent({
      provider: "quo",
      kind: "delivery",
      providerEventId: eventId,
      providerMessageId,
      providerEventType: eventType,
      rawBody: rawBody.text,
      occurredAt: str(resource.updatedAt) ?? str(resource.createdAt),
      providerStatus: token(resource.status),
      providerErrorCode: token(resource.errorCode),
      deliveryClassification: deliveryClassification(eventType),
    });
    if (!ingested.conflict) await projectSmsProviderEvent(ingested.eventId);
    return ok();
  }

  if (eventType === "call.completed") {
    const callId = str(resource.id);
    const participants = record(context.participants);
    const externalPhone = firstString(participants?.external);
    if (!callId || !phoneNumberId) return badRequest("missing call identity");
    if (!externalPhone) return ok();
    await logQuoCallActivity({
      kind: "call",
      callId,
      phoneNumberId,
      direction:
        str(resource.direction) === "outgoing" ? "outbound" : "inbound",
      externalPhone,
      status: str(resource.status),
      durationSeconds: num(resource.duration),
      hasVoicemail: resource.hasVoicemail === true,
      occurredAt: date(resource.createdAt),
      quoLink,
    });
    return ok();
  }

  if (eventType === "call.voicemail.completed") {
    const voicemailId = str(resource.voicemailId) ?? str(resource.id);
    const externalPhone =
      str(resource.from) ?? firstString(record(context.participants)?.external);
    if (!voicemailId || !phoneNumberId) {
      return badRequest("missing voicemail identity");
    }
    if (!externalPhone) return ok();
    await logQuoCallActivity({
      kind: "voicemail",
      voicemailId,
      phoneNumberId,
      externalPhone,
      durationSeconds: num(resource.duration),
      transcript: str(resource.transcript),
      occurredAt: date(resource.createdAt),
      quoLink,
    });
    return ok();
  }

  // Other subscribed events (ringing, contacts, tasks) are acknowledged.
  return ok();
}
