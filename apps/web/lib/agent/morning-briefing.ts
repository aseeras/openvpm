/**
 * Morning briefing: an optional email each morning to chosen veterinarians
 * and administrators with their visits for the day (in order, with addresses
 * and directions) and what is waiting for them (messages, texting drafts,
 * labs, unfinished notes, follow-ups).
 *
 * Built from the same queries as the assistant's get_my_day / get_my_todo
 * tools, without an AI model, so it costs nothing to run and states only
 * what is in the chart. Off unless a practice adds recipients in
 * `settings.morningBriefing`.
 */

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { practices, users } from "@openpims/db";
import type { Database } from "@openpims/db/client";
import { appBaseUrl } from "@/lib/app-url";
import { formatDateInputForTimeZone } from "@/lib/date-input";
import { sendEmail } from "@/lib/email";
import { withSystem, withTenant } from "@/lib/tenant-db";
import { loadMyDay, loadMyTodo, type MyDay, type MyTodo } from "./vet-tools";

export const MORNING_BRIEFING_DEFAULT_HOUR = 7;
/** Hours after the chosen time in which a missed run still sends. */
export const MORNING_BRIEFING_SEND_WINDOW_HOURS = 3;
export const MORNING_BRIEFING_ROLES = ["admin", "veterinarian"] as const;

export interface MorningBriefingSettings {
  /** Local hour (0-23, practice time zone) the briefing goes out. */
  hour: number;
  /** Staff user ids who get it, with the last local date it was sent. */
  recipients: Record<string, { lastSentDate?: string | null }>;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_INPUT = /^\d{4}-\d{2}-\d{2}$/;

export function morningBriefingFromSettings(
  settings: unknown,
): MorningBriefingSettings {
  const raw =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).morningBriefing
      : undefined;
  const value =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const hour =
    typeof value.hour === "number" &&
    Number.isInteger(value.hour) &&
    value.hour >= 0 &&
    value.hour <= 23
      ? value.hour
      : MORNING_BRIEFING_DEFAULT_HOUR;
  const recipients: MorningBriefingSettings["recipients"] = {};
  const rawRecipients =
    value.recipients && typeof value.recipients === "object"
      ? (value.recipients as Record<string, unknown>)
      : {};
  for (const [userId, entry] of Object.entries(rawRecipients)) {
    if (!UUID.test(userId)) continue;
    const last =
      entry && typeof entry === "object"
        ? (entry as Record<string, unknown>).lastSentDate
        : undefined;
    recipients[userId] = {
      lastSentDate: typeof last === "string" && DATE_INPUT.test(last) ? last : null,
    };
  }
  return { hour, recipients };
}

/** Local date and hour in the practice's time zone. */
export function practiceClock(
  now: Date,
  timeZone: string | null,
): { date: string; hour: number } {
  const date = formatDateInputForTimeZone(now, timeZone);
  let hour = now.getUTCHours();
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hourCycle: "h23",
      timeZone: timeZone ?? "UTC",
    }).formatToParts(now);
    const h = Number(parts.find((p) => p.type === "hour")?.value);
    if (Number.isInteger(h)) hour = h % 24;
  } catch {
    // Unknown time zone: fall back to UTC.
  }
  return { date, hour };
}

/** Whether the briefing should go out now (at or shortly after its hour). */
export function morningBriefingDue(input: {
  hour: number;
  localHour: number;
  lastSentDate?: string | null;
  today: string;
}): boolean {
  if (input.lastSentDate === input.today) return false;
  return (
    input.localHour >= input.hour &&
    input.localHour < input.hour + MORNING_BRIEFING_SEND_WINDOW_HOURS
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function absolute(baseUrl: string | null, path: string): string | null {
  if (/^https?:\/\//.test(path)) return path;
  return baseUrl ? `${baseUrl}${path}` : null;
}

function link(href: string | null, label: string): string {
  return href
    ? `<a href="${escapeHtml(href)}" style="color:#0f6e56">${escapeHtml(label)}</a>`
    : escapeHtml(label);
}

function friendlyDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

export function todoItemCount(todo: MyTodo): number {
  return (
    todo.unreadMessages.count +
    todo.textingDraftsToApprove.count +
    todo.labResults.count +
    todo.unfinishedSoapDrafts.length +
    todo.followUpsDue.length
  );
}

export function renderMorningBriefingEmail(opts: {
  practiceName: string;
  recipientName: string;
  day: MyDay;
  todo: MyTodo;
  baseUrl: string | null;
}): { subject: string; html: string } {
  const { day, todo, baseUrl } = opts;
  const visitCount = day.visits.length;
  const todoCount = todoItemCount(todo);
  const subject = `${opts.practiceName}: ${friendlyDate(day.date)} · ${visitCount} visit${visitCount === 1 ? "" : "s"}${todoCount ? `, ${todoCount} to-do` : ""}`;

  const visits = day.visits
    .map((v) => {
      const pet = v.patient
        ? `${v.patient.name ?? "Patient"}${v.patient.species ? ` (${[v.patient.age, v.patient.breed ?? v.patient.species].filter(Boolean).join(" ")})` : ""}`
        : "No patient on the appointment";
      const lines: string[] = [];
      if (v.client) {
        lines.push(
          [escapeHtml(v.client.name), v.client.phone ? escapeHtml(v.client.phone) : null]
            .filter(Boolean)
            .join(" · "),
        );
        if (v.client.address) {
          lines.push(
            `${escapeHtml(v.client.address)}${v.client.directions ? ` · ${link(v.client.directions, "Directions")}` : ""}`,
          );
        }
      }
      if (v.visitType || v.reasonOrNotes) {
        lines.push(
          escapeHtml([v.visitType, v.reasonOrNotes].filter(Boolean).join(": ")),
        );
      }
      if (v.patient?.allergies.length) {
        lines.push(
          `<strong style="color:#b42318">Allergies:</strong> ${escapeHtml(v.patient.allergies.join(", "))}`,
        );
      }
      if (v.patient?.activeProblems.length) {
        lines.push(`Active problems: ${escapeHtml(v.patient.activeProblems.join(", "))}`);
      }
      if (v.patient?.vaccinesDueWithin30Days.length) {
        lines.push(`Vaccines due: ${escapeHtml(v.patient.vaccinesDueWithin30Days.join(", "))}`);
      }
      lines.push(link(absolute(baseUrl, v.visitLink), "Open visit"));
      return `<li style="margin:0 0 14px"><strong>${escapeHtml(v.time)} · ${escapeHtml(pet)}</strong><br>${lines.join("<br>")}</li>`;
    })
    .join("");

  const todoLines: string[] = [];
  if (todo.unreadMessages.count) {
    todoLines.push(
      `${todo.unreadMessages.count} unread client message${todo.unreadMessages.count === 1 ? "" : "s"} · ${link(absolute(baseUrl, "/inbox"), "Inbox")}`,
    );
  }
  if (todo.textingDraftsToApprove.count) {
    todoLines.push(
      `${todo.textingDraftsToApprove.count} texting-assistant repl${todo.textingDraftsToApprove.count === 1 ? "y" : "ies"} waiting for approval · ${link(absolute(baseUrl, "/inbox"), "Inbox")}`,
    );
  }
  for (const lab of todo.labResults.items.slice(0, 10)) {
    todoLines.push(
      `Lab ${lab.needs}: ${escapeHtml(lab.patient ?? "Patient")}, ${escapeHtml(lab.test)}${lab.flag === "critical" || lab.flag === "abnormal" ? ` (<strong>${lab.flag}</strong>)` : ""} · ${link(absolute(baseUrl, lab.chartLink), "Chart")}`,
    );
  }
  for (const draft of todo.unfinishedSoapDrafts.slice(0, 10)) {
    todoLines.push(
      `Unsigned SOAP draft: ${escapeHtml(draft.patient ?? "Patient")} · ${link(absolute(baseUrl, draft.visitLink), "Open")}`,
    );
  }
  for (const f of todo.followUpsDue.slice(0, 10)) {
    todoLines.push(
      `Follow-up${f.dueDate ? ` due ${escapeHtml(String(f.dueDate))}` : ""}: ${escapeHtml(f.patient ?? "Patient")}${f.notes ? `, ${escapeHtml(f.notes)}` : ""} · ${link(absolute(baseUrl, f.visitLink), "Open")}`,
    );
  }

  const firstName = opts.recipientName.trim().split(/\s+/)[0] ?? "";
  const html = `<div style="font-family:-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a;max-width:640px">
<p>Good morning${firstName ? `, ${escapeHtml(firstName)}` : ""}. Here is ${escapeHtml(friendlyDate(day.date))}.</p>
<h3 style="margin:18px 0 8px">Visits (${visitCount})</h3>
${visitCount ? `<ol style="padding-left:20px;margin:0">${visits}</ol>` : "<p>No visits on the schedule today.</p>"}
<h3 style="margin:18px 0 8px">Waiting for you</h3>
${todoLines.length ? `<ul style="padding-left:20px;margin:0">${todoLines.map((l) => `<li style="margin:0 0 6px">${l}</li>`).join("")}</ul>` : "<p>Nothing waiting. Nice.</p>"}
<p style="margin-top:18px">${link(absolute(baseUrl, "/agent"), "Ask the assistant")} for anything else.</p>
<p style="color:#888;font-size:12px">You get this because you are on the morning briefing list on the assistant page. It contains clinic information; please don't forward it.</p>
</div>`;
  return { subject, html };
}

function safeBaseUrl(): string | null {
  try {
    return appBaseUrl();
  } catch {
    return null;
  }
}

/**
 * Send each due briefing once per local day. Each recipient is claimed under a
 * practice row lock, marked sent for the day, then emailed after commit, so a
 * concurrent or repeated run cannot send twice.
 */
export async function runMorningBriefings(
  rootDb: Database,
  now = new Date(),
): Promise<{ practices: number; sent: number; skipped: number; failed: number }> {
  const candidates = await withSystem(rootDb, (tx) =>
    tx
      .select({ id: practices.id })
      .from(practices)
      .where(
        and(
          isNull(practices.deletedAt),
          sql`jsonb_typeof(${practices.settings} -> 'morningBriefing' -> 'recipients') = 'object'`,
          sql`${practices.settings} -> 'morningBriefing' -> 'recipients' <> '{}'::jsonb`,
        ),
      ),
  );
  const baseUrl = safeBaseUrl();
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const { id: practiceId } of candidates) {
    const recipientIds = await withTenant(rootDb, practiceId, async (tx) => {
      const [practice] = await tx
        .select({ settings: practices.settings, timezone: practices.timezone })
        .from(practices)
        .where(and(eq(practices.id, practiceId), isNull(practices.deletedAt)))
        .limit(1);
      if (!practice) return [];
      const config = morningBriefingFromSettings(practice.settings);
      const clock = practiceClock(now, practice.timezone);
      return Object.entries(config.recipients)
        .filter(([, r]) =>
          morningBriefingDue({
            hour: config.hour,
            localHour: clock.hour,
            lastSentDate: r.lastSentDate,
            today: clock.date,
          }),
        )
        .map(([userId]) => userId);
    });

    for (const userId of recipientIds) {
      try {
        const email = await withTenant(rootDb, practiceId, async (tx) => {
          // Claim: lock the practice row and re-check before marking sent.
          const [practice] = await tx
            .select({
              name: practices.name,
              settings: practices.settings,
              timezone: practices.timezone,
            })
            .from(practices)
            .where(and(eq(practices.id, practiceId), isNull(practices.deletedAt)))
            .limit(1)
            .for("update");
          if (!practice) return null;
          const config = morningBriefingFromSettings(practice.settings);
          const clock = practiceClock(now, practice.timezone);
          const entry = config.recipients[userId];
          if (
            !entry ||
            !morningBriefingDue({
              hour: config.hour,
              localHour: clock.hour,
              lastSentDate: entry.lastSentDate,
              today: clock.date,
            })
          ) {
            return null;
          }
          await tx.execute(sql`
            update ${practices}
            set settings = jsonb_set(
              ${practices.settings},
              ${sql.raw(`'{morningBriefing,recipients,${userId}}'`)},
              ${JSON.stringify({ lastSentDate: clock.date })}::jsonb,
              true
            )
            where ${practices.id} = ${practiceId}
          `);

          const [user] = await tx
            .select({ id: users.id, name: users.name, email: users.email, role: users.role })
            .from(users)
            .where(
              and(
                eq(users.id, userId),
                eq(users.practiceId, practiceId),
                isNull(users.deletedAt),
                inArray(users.role, [...MORNING_BRIEFING_ROLES]),
              ),
            )
            .limit(1);
          if (!user) return null;

          const ctx = {
            db: tx,
            practiceId,
            userId: user.id,
            staffUser: { id: user.id, name: user.name, role: user.role },
          };
          const day = await loadMyDay(ctx, { date: clock.date, onlyMine: true });
          const todo = await loadMyTodo(ctx);
          if (!todo) return null;
          // Nothing scheduled and nothing waiting: no email (e.g. days off).
          if (day.visits.length === 0 && todoItemCount(todo) === 0) return null;
          return {
            to: user.email,
            ...renderMorningBriefingEmail({
              practiceName: practice.name,
              recipientName: user.name,
              day,
              todo,
              baseUrl,
            }),
            idempotencyKey: `morning-briefing:${practiceId}:${user.id}:${clock.date}`,
          };
        });
        if (!email) {
          skipped += 1;
          continue;
        }
        const result = await sendEmail({ ...email, redactRecipientInLogs: true });
        if (result.success) sent += 1;
        else {
          failed += 1;
          console.error("[MorningBriefing] email not sent:", result.error);
        }
      } catch {
        failed += 1;
        // No error details: they may contain clinical data.
        console.error("[MorningBriefing] briefing failed for a recipient");
      }
    }
  }
  return { practices: candidates.length, sent, skipped, failed };
}
