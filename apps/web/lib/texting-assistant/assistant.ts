import { generateText, stepCountIs, tool } from "ai";
import { and, desc, eq, gte, isNull, like, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  appointments,
  clients,
  communications,
  locationMessaging,
  patients,
  practices,
} from "@openpims/db";
import { db, type Database } from "@openpims/db/client";
import { configuredModel, isAgentConfigured } from "@/lib/agent/runner";
import { getTool, type AgentToolContext } from "@/lib/agent/tools";
import { queueInboxAlert } from "@/lib/communications/inbox-alert";
import { withDurableSmsCommunication } from "@/lib/messaging/durable-sms-communication";
import { sendSms } from "@/lib/sms";
import { withSystem, withTenant } from "@/lib/tenant-db";
import {
  AFTER_HOURS_REPLY,
  CONVERSATION_GAP_MS,
  defaultAssistantIntro,
  EMERGENCY_REPLY,
  HANDOFF_PAUSE_MS,
  localClock,
  looksLikeEmergency,
  MAX_REPLIES_PER_DAY,
  STAFF_TAKEOVER_MS,
  withinOfficeHours,
  withIntro,
} from "./policy";
import {
  textingAssistantSettingsFrom,
  type TextingAssistantSettings,
} from "./settings";

/**
 * The texting assistant: Claude replies to client texts on the clinic's
 * behalf. It never confirms a visit. Bookings become held "scheduled"
 * appointments plus an Inbox card that staff approve or decline.
 *
 * Every row it writes is a normal Communications entry, tagged by dedupe key:
 *   assistant:reply:<inbound id>     a reply (sent, or a draft in draft mode)
 *   assistant:handoff:<inbound id>   a note asking staff to take over
 *   assistant:booking:<appointment>  a booking request held for approval
 *   assistant:newclient:<inbound id> a new-client visit request
 */

export const ASSISTANT_KEY_PREFIX = "assistant:";

const MAX_HISTORY = 20;
const MAX_STEPS = 6;
const MAX_REPLY_LENGTH = 600;
const AFTER_HOURS_NOTE_WINDOW_MS = 16 * 60 * 60 * 1000;
/** Wait before replying so a client can finish a multi-part message. */
export const REPLY_DELAY_MS = 45_000;

export const replySubject = (phone: string, draft: boolean) =>
  draft ? `Assistant draft reply to ${phone}` : `Assistant reply to ${phone}`;
const handoffSubject = (phone: string, urgent: boolean) =>
  urgent
    ? `URGENT, assistant handoff: ${phone}`
    : `Assistant handoff: ${phone}`;
export const bookingSubject = (phone: string) =>
  `Booking request from the assistant: ${phone}`;

type Practice = {
  id: string;
  name: string;
  timezone: string;
  settings: TextingAssistantSettings;
};

type InboundText = {
  practiceId: string;
  communicationId: string;
  clientId: string | null;
  fromPhone: string;
  text: string;
  receivedAt: Date;
};

export type AssistantOutcome =
  | "off"
  | "skipped_staff_active"
  | "skipped_handoff"
  | "skipped_daily_limit"
  | "skipped_duplicate"
  | "skipped_newer_text"
  | "after_hours_note"
  | "after_hours_quiet"
  | "emergency"
  | "replied"
  | "drafted"
  | "not_configured"
  | "failed";

async function loadPractice(practiceId: string): Promise<Practice | null> {
  const [row] = await withSystem(db, (tx) =>
    tx
      .select({
        id: practices.id,
        name: practices.name,
        timezone: practices.timezone,
        settings: practices.settings,
      })
      .from(practices)
      .where(and(eq(practices.id, practiceId), isNull(practices.deletedAt)))
      .limit(1),
  );
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    timezone: row.timezone || "America/New_York",
    settings: textingAssistantSettingsFrom(row.settings),
  };
}

/** Comms about this phone number: the client's texts and assistant entries. */
function phoneCondition(phone: string, clientId: string | null) {
  return or(
    eq(communications.subject, `SMS from ${phone}`),
    like(communications.subject, `%: ${phone}`),
    like(communications.subject, `% to ${phone}`),
    clientId
      ? and(
          eq(communications.clientId, clientId),
          eq(communications.channel, "sms"),
        )
      : undefined,
  );
}

async function recentConversation(
  tx: Database,
  practiceId: string,
  phone: string,
  clientId: string | null,
) {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const rows = await tx
    .select({
      id: communications.id,
      direction: communications.direction,
      subject: communications.subject,
      content: communications.content,
      status: communications.status,
      dedupeKey: communications.dedupeKey,
      createdAt: communications.createdAt,
    })
    .from(communications)
    .where(
      and(
        eq(communications.practiceId, practiceId),
        isNull(communications.deletedAt),
        gte(communications.createdAt, since),
        phoneCondition(phone, clientId),
      ),
    )
    .orderBy(desc(communications.createdAt))
    .limit(60);
  return rows;
}

type ConversationRow = Awaited<ReturnType<typeof recentConversation>>[number];

const isAssistantRow = (row: ConversationRow) =>
  row.dedupeKey?.startsWith(ASSISTANT_KEY_PREFIX) ?? false;

/** Guards that stop the assistant before any model call. */
export function assistantGuard(
  rows: ConversationRow[],
  now: Date,
  inboundId: string,
):
  | "skipped_staff_active"
  | "skipped_handoff"
  | "skipped_daily_limit"
  | "skipped_duplicate"
  | null {
  const at = (row: ConversationRow) => new Date(row.createdAt).getTime();
  if (rows.some((row) => row.dedupeKey === `assistant:reply:${inboundId}`)) {
    return "skipped_duplicate";
  }
  const staffReply = rows.find(
    (row) =>
      row.direction === "outbound" &&
      !isAssistantRow(row) &&
      row.status !== "draft" &&
      now.getTime() - at(row) < STAFF_TAKEOVER_MS,
  );
  if (staffReply) return "skipped_staff_active";
  const handoff = rows.find(
    (row) =>
      row.dedupeKey?.startsWith("assistant:handoff:") &&
      now.getTime() - at(row) < HANDOFF_PAUSE_MS,
  );
  if (handoff) return "skipped_handoff";
  const repliesToday = rows.filter(
    (row) =>
      row.dedupeKey?.startsWith("assistant:reply:") &&
      now.getTime() - at(row) < 24 * 60 * 60 * 1000,
  ).length;
  if (repliesToday >= MAX_REPLIES_PER_DAY) return "skipped_daily_limit";
  return null;
}

function isFirstReply(rows: ConversationRow[], now: Date): boolean {
  return !rows.some(
    (row) =>
      row.direction === "outbound" &&
      now.getTime() - new Date(row.createdAt).getTime() < CONVERSATION_GAP_MS,
  );
}

async function messagingLocationId(practiceId: string) {
  const rows = await withSystem(db, (tx) =>
    tx
      .select({ locationId: locationMessaging.locationId })
      .from(locationMessaging)
      .where(
        and(
          eq(locationMessaging.practiceId, practiceId),
          isNull(locationMessaging.deletedAt),
        ),
      )
      .limit(2),
  );
  return rows.length === 1 ? rows[0]!.locationId : undefined;
}

/**
 * Text a client through the normal SMS path (consent, opt-out, delivery
 * ledger) and keep the Communications row in step. With `draftId`, an
 * existing assistant draft is sent instead of inserting a new row.
 */
export async function sendClinicText(opts: {
  practiceId: string;
  to: string;
  body: string;
  clientId: string | null;
  subject: string;
  dedupeKey: string;
  draftId?: string;
  sourceId: string;
}): Promise<{ status: "sent" | "duplicate" | "failed"; error?: string }> {
  const content = opts.body.trim().slice(0, MAX_REPLY_LENGTH);
  const claim = await withDurableSmsCommunication(
    opts.practiceId,
    async (tx) => {
      if (opts.draftId) {
        const [row] = await tx
          .update(communications)
          .set({
            status: "pending",
            content,
            subject: opts.subject,
            createdAt: new Date(),
          })
          .where(
            and(
              eq(communications.id, opts.draftId),
              eq(communications.practiceId, opts.practiceId),
              eq(communications.status, "draft"),
              isNull(communications.deletedAt),
            ),
          )
          .returning({
            id: communications.id,
            dedupeKey: communications.dedupeKey,
          });
        return row;
      }
      const [row] = await tx
        .insert(communications)
        .values({
          practiceId: opts.practiceId,
          clientId: opts.clientId ?? undefined,
          channel: "sms",
          direction: "outbound",
          subject: opts.subject,
          content,
          status: "pending",
          dedupeKey: opts.dedupeKey,
        })
        .onConflictDoNothing({ target: communications.dedupeKey })
        .returning({
          id: communications.id,
          dedupeKey: communications.dedupeKey,
        });
      return row;
    },
  );
  if (!claim) return { status: "duplicate" };

  const result = await sendSms({
    to: opts.to,
    body: content,
    practiceId: opts.practiceId,
    locationId: await messagingLocationId(opts.practiceId),
    clientId: opts.clientId ?? undefined,
    communicationId: claim.id,
    source: "texting_assistant",
    sourceId: opts.sourceId,
    idempotencyKey: claim.dedupeKey ?? opts.dedupeKey,
  });
  const error = result.success ? undefined : (result.error ?? "send failed");
  await withDurableSmsCommunication(opts.practiceId, (tx) =>
    tx
      .update(communications)
      .set({
        status: result.success ? "sent" : "failed",
        ...(result.sid ? { providerMessageId: result.sid } : {}),
        ...(error
          ? { subject: `${opts.subject} (not sent: ${error.slice(0, 120)})` }
          : {}),
      })
      .where(
        and(
          eq(communications.id, claim.id),
          eq(communications.practiceId, opts.practiceId),
          eq(communications.status, "pending"),
        ),
      ),
  );
  return result.success ? { status: "sent" } : { status: "failed", error };
}

/** Save a text for staff to review and send from the Inbox. */
export async function saveDraftText(opts: {
  practiceId: string;
  clientId: string | null;
  subject: string;
  body: string;
  dedupeKey: string;
}) {
  await withDurableSmsCommunication(opts.practiceId, (tx) =>
    tx
      .insert(communications)
      .values({
        practiceId: opts.practiceId,
        clientId: opts.clientId ?? undefined,
        channel: "sms",
        direction: "outbound",
        subject: opts.subject,
        content: opts.body.trim().slice(0, MAX_REPLY_LENGTH),
        status: "draft",
        dedupeKey: opts.dedupeKey,
      })
      .onConflictDoNothing({ target: communications.dedupeKey }),
  );
}

/**
 * Deliver a reply: in live mode it is texted right away; in draft mode it
 * is saved for staff to send.
 */
async function deliverReply(
  practice: Practice,
  inbound: InboundText,
  body: string,
): Promise<"replied" | "drafted" | "failed"> {
  const dedupeKey = `assistant:reply:${inbound.communicationId}`;
  if (practice.settings.mode !== "live") {
    await saveDraftText({
      practiceId: practice.id,
      clientId: inbound.clientId,
      subject: replySubject(inbound.fromPhone, true),
      body,
      dedupeKey,
    });
    return "drafted";
  }
  const result = await sendClinicText({
    practiceId: practice.id,
    to: inbound.fromPhone,
    body,
    clientId: inbound.clientId,
    subject: replySubject(inbound.fromPhone, false),
    dedupeKey,
    sourceId: inbound.communicationId,
  });
  return result.status === "failed" ? "failed" : "replied";
}

async function recordStaffNote(
  practice: Practice,
  inbound: InboundText,
  note: { key: string; subject: string; content: string; alert?: boolean },
) {
  await withTenant(db, practice.id, async (tx) => {
    const inserted = await tx
      .insert(communications)
      .values({
        practiceId: practice.id,
        clientId: inbound.clientId ?? undefined,
        channel: "sms",
        direction: "inbound",
        subject: note.subject,
        content: note.content,
        status: "delivered",
        dedupeKey: note.key,
      })
      .onConflictDoNothing({ target: communications.dedupeKey })
      .returning({ id: communications.id });
    if (inserted.length > 0 && note.alert) {
      await queueInboxAlert({ db: tx }, practice.id, {
        subject: note.subject,
        content: note.content,
      });
    }
  });
}

function formatLocal(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function systemPrompt(practice: Practice, today: string) {
  return `You are the texting assistant for ${practice.name}, a veterinary practice. You reply to client text messages. Today is ${today} (${practice.timezone}).

Facts you may share (use ONLY these; if something isn't here, say the team will follow up):
"""
${practice.settings.info.trim() || "(No info sheet yet. Do not state services, areas, hours or prices; offer to have the team follow up.)"}
"""

Rules:
- Write short, warm, plain texts (1 to 3 sentences, under 320 characters). No emoji, no markdown, no links unless they are in the facts.
- Never give medical advice, diagnoses, drug or dose information, or interpret symptoms or test results. Offer a visit or hand off to staff.
${
  practice.settings.sharePrices
    ? "- You may share prices exactly as written in the facts, as estimates. Never quote a price that isn't there or promise anything not in the facts."
    : '- Never quote prices or promise anything not in the facts, even if prices appear above. Pricing: "The team will share pricing with you."'
}
- You cannot confirm appointments. To book: use find_open_times to offer two or three real times, and when the client picks one call request_booking. Then tell them the team will confirm shortly.
- For someone who is not a client yet, collect their name, pet's name and species, town or address, and the reason for the visit, then call request_booking with those details.
- Call hand_off_to_staff (and tell the client the team will follow up) for: complaints, billing, refills or medications, test results, anything you cannot answer from the facts, or when they ask for a person.
- Never claim to be the veterinarian, a staff member or a human. Never ask for payment details.
- Your final message is the exact text sent to the client.`;
}

function transcript(rows: ConversationRow[], practice: Practice) {
  return [...rows]
    .reverse()
    .filter((row) => row.status !== "draft" && row.content)
    .slice(-MAX_HISTORY)
    .map((row) => {
      const when = formatLocal(new Date(row.createdAt), practice.timezone);
      if (row.dedupeKey?.startsWith("assistant:handoff:")) {
        return `[${when}] (internal note) ${row.content}`;
      }
      if (row.dedupeKey?.startsWith("assistant:booking:")) {
        return `[${when}] (internal) booking request created: ${row.content}`;
      }
      return `[${when}] ${row.direction === "inbound" ? "Client" : "Clinic"}: ${row.content}`;
    })
    .join("\n");
}

async function clientContext(practiceId: string, clientId: string | null) {
  if (!clientId) return null;
  return withSystem(db, async (tx) => {
    const [client] = await tx
      .select({ firstName: clients.firstName, lastName: clients.lastName })
      .from(clients)
      .where(
        and(
          eq(clients.id, clientId),
          eq(clients.practiceId, practiceId),
          isNull(clients.deletedAt),
        ),
      )
      .limit(1);
    if (!client) return null;
    const pets = await tx
      .select({
        id: patients.id,
        name: patients.name,
        species: patients.species,
      })
      .from(patients)
      .where(
        and(
          eq(patients.clientId, clientId),
          eq(patients.practiceId, practiceId),
          eq(patients.status, "active"),
          isNull(patients.deletedAt),
        ),
      )
      .limit(20);
    const upcoming = await tx
      .select({
        startTime: appointments.startTime,
        status: appointments.status,
      })
      .from(appointments)
      .where(
        and(
          eq(appointments.clientId, clientId),
          eq(appointments.practiceId, practiceId),
          isNull(appointments.deletedAt),
          gte(appointments.startTime, new Date()),
          sql`${appointments.status} in ('scheduled', 'confirmed')`,
        ),
      )
      .orderBy(appointments.startTime)
      .limit(5);
    return { client, pets, upcoming };
  });
}

async function runModel(
  practice: Practice,
  inbound: InboundText,
  rows: ConversationRow[],
): Promise<{ reply: string; handedOff: boolean }> {
  const now = new Date();
  const today = localClock(now, practice.timezone).date;
  const known = await clientContext(practice.id, inbound.clientId);
  let handedOff = false;

  const toolContext = (tx: Database): AgentToolContext => ({
    db: tx,
    practiceId: practice.id,
    userId: "texting-assistant",
  });

  const tools = {
    find_open_times: tool({
      description:
        "Find open visit times on a date (YYYY-MM-DD, within the next 30 days). Returns up to 6 start times in clinic local time.",
      inputSchema: z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        durationMinutes: z.number().int().min(30).max(120).optional(),
      }),
      execute: async ({ date, durationMinutes }) => {
        const days = (Date.parse(date) - Date.parse(today)) / 86_400_000;
        if (!(days >= 0 && days <= 30)) {
          return { error: "Pick a date within the next 30 days." };
        }
        const finder = getTool("find_open_slots")!;
        const slots = (await withTenant(db, practice.id, (tx) =>
          finder.execute(
            { date, durationMinutes: durationMinutes ?? 60 },
            toolContext(tx),
          ),
        )) as Array<{ start: string; end: string }> | { error: string };
        if (!Array.isArray(slots)) return slots;
        return slots
          .filter((slot) => new Date(slot.start) > now)
          .filter((_, index) => index % 2 === 0)
          .slice(0, 6)
          .map((slot) => ({
            start: slot.start,
            end: slot.end,
            label: formatLocal(new Date(slot.start), practice.timezone),
          }));
      },
    }),
    request_booking: tool({
      description:
        "Hold a visit for staff approval once the client has picked a time. Use start/end from find_open_times. For a new client include their details.",
      inputSchema: z.object({
        start: z.string().datetime({ offset: true }),
        end: z.string().datetime({ offset: true }),
        petName: z.string().trim().min(1).max(100),
        reason: z.string().trim().min(1).max(300),
        newClientName: z.string().trim().max(120).optional(),
        species: z.string().trim().max(60).optional(),
        address: z.string().trim().max(200).optional(),
      }),
      execute: async (input) => {
        const when = formatLocal(new Date(input.start), practice.timezone);
        const pet = known?.pets.find(
          (candidate) =>
            candidate.name.trim().toLowerCase() ===
            input.petName.trim().toLowerCase(),
        );
        const details = [
          `Phone: ${inbound.fromPhone}`,
          known
            ? `Client: ${known.client.firstName} ${known.client.lastName}`
            : `New client: ${input.newClientName ?? "(name not given)"}`,
          `Pet: ${input.petName}${input.species ? ` (${input.species})` : ""}`,
          `Requested time: ${when}`,
          input.address ? `Address: ${input.address}` : null,
          `Reason: ${input.reason}`,
        ]
          .filter(Boolean)
          .join("\n");

        if (!known || !pet) {
          await recordStaffNote(practice, inbound, {
            key: `assistant:newclient:${inbound.communicationId}`,
            subject: bookingSubject(inbound.fromPhone),
            content: `${details}\n\nNot held on the schedule: ${
              known
                ? "this pet isn't on the client's record yet"
                : "this is a new client"
            }. Add them, book the visit, then text them to confirm.`,
            alert: true,
          });
          return { ok: true, held: false };
        }

        const booker = getTool("book_appointment")!;
        const created = (await withTenant(db, practice.id, (tx) =>
          booker.execute(
            {
              startTime: input.start,
              endTime: input.end,
              clientId: inbound.clientId,
              patientId: pet.id,
              notes: `[Text assistant request] ${input.reason}`.slice(0, 2000),
            },
            toolContext(tx),
          ),
        )) as { id?: string; error?: string };
        if (!created.id) {
          return { error: created.error ?? "That time is no longer open." };
        }
        await recordStaffNote(practice, inbound, {
          key: `assistant:booking:${created.id}`,
          subject: bookingSubject(inbound.fromPhone),
          content: `${details}\n\nHeld on the schedule until you approve or decline it.`,
          alert: true,
        });
        return { ok: true, held: true };
      },
    }),
    hand_off_to_staff: tool({
      description:
        "Ask the clinic team to take over this conversation. You stop replying to this number for 24 hours.",
      inputSchema: z.object({
        reason: z.string().trim().min(1).max(300),
        urgent: z.boolean().optional(),
      }),
      execute: async ({ reason, urgent }) => {
        handedOff = true;
        await recordStaffNote(practice, inbound, {
          key: `assistant:handoff:${inbound.communicationId}`,
          subject: handoffSubject(inbound.fromPhone, urgent === true),
          content: `The assistant handed this conversation to staff: ${reason}`,
          alert: true,
        });
        return { ok: true };
      },
    }),
  };

  const about = known
    ? `The texter is an existing client: ${known.client.firstName} ${known.client.lastName}. Pets: ${
        known.pets.map((pet) => `${pet.name} (${pet.species})`).join(", ") ||
        "none on file"
      }. Upcoming visits: ${
        known.upcoming
          .map(
            (visit) =>
              `${formatLocal(visit.startTime, practice.timezone)} (${visit.status})`,
          )
          .join(", ") || "none"
      }.`
    : "The texter is not matched to a client record (likely a new client).";

  const result = await generateText({
    model: configuredModel(),
    system: systemPrompt(practice, today),
    prompt: `${about}\n\nConversation (oldest first):\n${transcript(rows, practice)}\n\nWrite the clinic's next text to the client.`,
    tools,
    stopWhen: stepCountIs(MAX_STEPS),
    maxOutputTokens: 600,
  });
  return { reply: result.text.trim(), handedOff };
}

/**
 * Entry point, called after an inbound client text is in the Inbox. Never
 * throws: a failure leaves the text for staff, exactly as before.
 */
export async function handleInboundTextForAssistant(input: {
  practiceId: string;
  communicationId: string;
}): Promise<AssistantOutcome> {
  try {
    const practice = await loadPractice(input.practiceId);
    if (!practice || practice.settings.mode === "off") return "off";

    const [row] = await withSystem(db, (tx) =>
      tx
        .select({
          id: communications.id,
          clientId: communications.clientId,
          subject: communications.subject,
          content: communications.content,
          createdAt: communications.createdAt,
        })
        .from(communications)
        .where(
          and(
            eq(communications.id, input.communicationId),
            eq(communications.practiceId, input.practiceId),
            eq(communications.channel, "sms"),
            eq(communications.direction, "inbound"),
            isNull(communications.deletedAt),
          ),
        )
        .limit(1),
    );
    const fromPhone = row?.subject?.match(/^SMS from (\+\d{8,15})$/)?.[1];
    if (!row || !fromPhone || !row.content?.trim()) return "off";
    const inbound: InboundText = {
      practiceId: input.practiceId,
      communicationId: row.id,
      clientId: row.clientId,
      fromPhone,
      text: row.content.trim(),
      receivedAt: new Date(row.createdAt),
    };

    const now = new Date();
    const rows = await withSystem(db, (tx) =>
      recentConversation(tx, practice.id, fromPhone, row.clientId),
    );
    const blocked = assistantGuard(rows, now, row.id);
    if (blocked) return blocked;
    // Clients often send a thought in two or three texts; answer the last one.
    const newerText = rows.some(
      (r) =>
        r.direction === "inbound" &&
        r.subject === `SMS from ${fromPhone}` &&
        r.id !== row.id &&
        new Date(r.createdAt).getTime() > inbound.receivedAt.getTime(),
    );
    if (newerText) return "skipped_newer_text";
    const firstReply = isFirstReply(rows, now);
    const intro =
      practice.settings.intro || defaultAssistantIntro(practice.name);

    if (looksLikeEmergency(inbound.text)) {
      await recordStaffNote(practice, inbound, {
        key: `assistant:handoff:${row.id}`,
        subject: handoffSubject(fromPhone, true),
        content: `Possible emergency. The assistant told the client to call a 24-hour emergency vet. Their message: "${inbound.text.slice(0, 500)}"`,
        alert: true,
      });
      await deliverReply(
        practice,
        inbound,
        withIntro(EMERGENCY_REPLY, firstReply, intro),
      );
      return "emergency";
    }

    if (!withinOfficeHours(now, practice.timezone, practice.settings.hours)) {
      // One closed-office note per evening or weekend, not one per text.
      const notedRecently = rows.some(
        (r) =>
          r.content?.endsWith(AFTER_HOURS_REPLY) &&
          now.getTime() - new Date(r.createdAt).getTime() <
            AFTER_HOURS_NOTE_WINDOW_MS,
      );
      if (notedRecently) return "after_hours_quiet";
      const outcome = await deliverReply(
        practice,
        inbound,
        withIntro(AFTER_HOURS_REPLY, firstReply, intro),
      );
      return outcome === "failed" ? "failed" : "after_hours_note";
    }

    if (!isAgentConfigured()) return "not_configured";
    const { reply } = await runModel(practice, inbound, rows);
    if (!reply) return "failed";
    const outcome = await deliverReply(
      practice,
      inbound,
      withIntro(reply, firstReply, intro),
    );
    return outcome;
  } catch (error) {
    console.error("[texting-assistant] reply failed", error);
    return "failed";
  }
}

/**
 * Called by the SMS webhook once an inbound text is stored. Waits briefly,
 * then lets the assistant answer. Never throws.
 */
export async function replyToInboundTextLater(input: {
  dedupeKey: string;
  delayMs?: number;
}): Promise<AssistantOutcome> {
  try {
    const [row] = await withSystem(db, (tx) =>
      tx
        .select({
          id: communications.id,
          practiceId: communications.practiceId,
        })
        .from(communications)
        .where(eq(communications.dedupeKey, input.dedupeKey))
        .limit(1),
    );
    if (!row) return "off";
    const practice = await loadPractice(row.practiceId);
    if (!practice || practice.settings.mode === "off") return "off";
    await new Promise((resolve) =>
      setTimeout(resolve, input.delayMs ?? REPLY_DELAY_MS),
    );
    const outcome = await handleInboundTextForAssistant({
      practiceId: row.practiceId,
      communicationId: row.id,
    });
    console.log("[texting-assistant] outcome", { outcome });
    return outcome;
  } catch (error) {
    console.error("[texting-assistant] scheduling failed", error);
    return "failed";
  }
}

/** The client's number from an assistant entry's subject line. */
export function phoneFromAssistantSubject(
  subject: string | null,
): string | null {
  return subject?.match(/(\+\d{8,15})(?=$|\s|\))/)?.[1] ?? null;
}

export { loadPractice as loadAssistantPractice, formatLocal };
