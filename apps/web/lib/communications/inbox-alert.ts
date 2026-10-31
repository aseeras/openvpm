/**
 * Optional email alert for new inbound inbox items (portal messages,
 * appointment requests, online bookings). Small clinics often don't keep the
 * app open all day; this lets them hear about a new request in their normal
 * mailbox. Off unless the practice sets `settings.inboxAlertEmail`.
 */

import { eq } from "drizzle-orm";
import { practices } from "@openpims/db";
import type { Database } from "@openpims/db/client";
import { sendEmail } from "@/lib/email";
import { appBaseUrl } from "@/lib/app-url";

const SIMPLE_EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const ALERT_CONTENT_MAX_LENGTH = 2000;

export function inboxAlertEmailFromSettings(settings: unknown): string | null {
  if (!settings || typeof settings !== "object") return null;
  const raw = (settings as Record<string, unknown>).inboxAlertEmail;
  if (typeof raw !== "string") return null;
  const email = raw.trim();
  return SIMPLE_EMAIL_PATTERN.test(email) ? email : null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderInboxAlertEmail(opts: {
  practiceName: string;
  subject: string;
  content: string;
  inboxUrl: string | null;
}): { subject: string; html: string } {
  const content =
    opts.content.length > ALERT_CONTENT_MAX_LENGTH
      ? `${opts.content.slice(0, ALERT_CONTENT_MAX_LENGTH)}…`
      : opts.content;
  const body = escapeHtml(content).replace(/\n/g, "<br>");
  const link = opts.inboxUrl
    ? `<p><a href="${escapeHtml(opts.inboxUrl)}">Open the inbox</a> to reply or confirm.</p>`
    : "";
  return {
    subject: `${opts.practiceName}: ${opts.subject}`,
    html: `<div style="font-family:sans-serif;font-size:14px;line-height:1.5">
<p><strong>${escapeHtml(opts.subject)}</strong></p>
<p>${body}</p>
${link}
<p style="color:#888;font-size:12px">You get this because an inbox alert email is set in Settings &gt; Practice.</p>
</div>`,
  };
}

function inboxUrl(): string | null {
  try {
    return `${appBaseUrl()}/inbox`;
  } catch {
    return null;
  }
}

/**
 * Looks up the practice's alert address inside the current transaction and,
 * if one is set, emails it once the transaction commits. Never throws: a
 * failed alert must not fail the client's request.
 */
export async function queueInboxAlert(
  ctx: {
    db: Database;
    postCommitEffect?: (effect: (rootDb: Database) => Promise<void>) => void;
  },
  practiceId: string,
  alert: { subject: string; content: string },
): Promise<void> {
  try {
    const [practice] = await ctx.db
      .select({ name: practices.name, settings: practices.settings })
      .from(practices)
      .where(eq(practices.id, practiceId))
      .limit(1);
    const to = inboxAlertEmailFromSettings(practice?.settings);
    if (!practice || !to) return;

    const email = renderInboxAlertEmail({
      practiceName: practice.name,
      subject: alert.subject,
      content: alert.content,
      inboxUrl: inboxUrl(),
    });
    const send = async () => {
      const result = await sendEmail({ to, ...email });
      if (!result.success) {
        console.error("[InboxAlert] email not sent:", result.error);
      }
    };
    if (ctx.postCommitEffect) {
      ctx.postCommitEffect(async () => {
        await send().catch((err) => console.error("[InboxAlert]", err));
      });
    } else {
      await send();
    }
  } catch (err) {
    console.error("[InboxAlert]", err);
  }
}
