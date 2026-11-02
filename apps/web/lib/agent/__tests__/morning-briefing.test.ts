import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MORNING_BRIEFING_DEFAULT_HOUR,
  morningBriefingDue,
  morningBriefingFromSettings,
  practiceClock,
  renderMorningBriefingEmail,
  todoItemCount,
} from "../morning-briefing";
import type { MyDay, MyTodo } from "../vet-tools";

const USER = "0b9c1e7a-3f1d-4a52-9a77-1c2d3e4f5a6b";

function emptyTodo(): MyTodo {
  return {
    unreadMessages: { count: 0, latest: [], link: "/inbox" },
    textingDraftsToApprove: { count: 0, latest: [], link: "/inbox" },
    labResults: { count: 0, items: [], link: "/lab-results" },
    unfinishedSoapDrafts: [],
    followUpsDue: [],
  };
}

function day(visits: MyDay["visits"] = []): MyDay {
  return { date: "2026-11-02", timeZone: "America/New_York", visitCount: visits.length, visits };
}

describe("morningBriefingFromSettings", () => {
  it("defaults to 7 AM and no recipients", () => {
    expect(morningBriefingFromSettings(null)).toEqual({
      hour: MORNING_BRIEFING_DEFAULT_HOUR,
      recipients: {},
    });
    expect(morningBriefingFromSettings({ morningBriefing: "x" })).toEqual({
      hour: 7,
      recipients: {},
    });
  });

  it("keeps valid hours, user ids and sent dates only", () => {
    expect(
      morningBriefingFromSettings({
        morningBriefing: {
          hour: 6,
          recipients: {
            [USER]: { lastSentDate: "2026-11-01" },
            "not-a-user": {},
          },
        },
      }),
    ).toEqual({ hour: 6, recipients: { [USER]: { lastSentDate: "2026-11-01" } } });
    expect(
      morningBriefingFromSettings({ morningBriefing: { hour: 24 } }).hour,
    ).toBe(7);
    expect(
      morningBriefingFromSettings({
        morningBriefing: { recipients: { [USER]: { lastSentDate: "yesterday" } } },
      }).recipients[USER],
    ).toEqual({ lastSentDate: null });
  });
});

describe("practiceClock and morningBriefingDue", () => {
  it("reads the local date and hour in the practice time zone", () => {
    // 11:30 UTC is 6:30 AM in New York (EST) on Nov 2, 2026.
    expect(practiceClock(new Date("2026-11-02T11:30:00Z"), "America/New_York")).toEqual({
      date: "2026-11-02",
      hour: 6,
    });
    expect(practiceClock(new Date("2026-11-02T03:30:00Z"), "America/New_York")).toEqual({
      date: "2026-11-01",
      hour: 22,
    });
  });

  it("sends once per day, from the chosen hour through a short catch-up window", () => {
    const base = { hour: 7, today: "2026-11-02" };
    expect(morningBriefingDue({ ...base, localHour: 6 })).toBe(false);
    expect(morningBriefingDue({ ...base, localHour: 7 })).toBe(true);
    expect(morningBriefingDue({ ...base, localHour: 9 })).toBe(true);
    expect(morningBriefingDue({ ...base, localHour: 10 })).toBe(false);
    expect(
      morningBriefingDue({ ...base, localHour: 7, lastSentDate: "2026-11-02" }),
    ).toBe(false);
    expect(
      morningBriefingDue({ ...base, localHour: 7, lastSentDate: "2026-11-01" }),
    ).toBe(true);
  });
});

describe("renderMorningBriefingEmail", () => {
  const visit: MyDay["visits"][number] = {
    appointmentId: "a1",
    time: "9:00 AM–10:00 AM",
    status: "scheduled",
    visitType: "Acupuncture",
    veterinarian: "Dr. Example",
    reasonOrNotes: "Hind-limb stiffness <follow-up>",
    client: {
      id: "c1",
      name: "Sam Rivera",
      phone: "555-0100",
      address: "12 Palm Way, Tampa, FL 33602",
      directions: "https://www.google.com/maps/dir/?api=1&destination=12%20Palm%20Way",
      notes: null,
    },
    patient: {
      id: "p1",
      name: "Bella",
      species: "canine",
      breed: "Labrador",
      sex: "female",
      age: "11 yr",
      allergies: ["Penicillin (severe)"],
      activeProblems: ["Osteoarthritis"],
      vaccinesDueWithin30Days: ["Rabies (due 2026-11-20)"],
      chartLink: "/patients/p1",
    },
    visitLink: "/encounters/a1",
  } as MyDay["visits"][number];

  it("lists visits with address, directions, allergies and absolute links", () => {
    const todo = emptyTodo();
    todo.unreadMessages.count = 2;
    const email = renderMorningBriefingEmail({
      practiceName: "Clinic",
      recipientName: "Jordan Lee",
      day: day([visit]),
      todo,
      baseUrl: "https://vpm.example",
    });
    expect(email.subject).toBe("Clinic: Monday, November 2 · 1 visit, 2 to-do");
    expect(email.html).toContain("Good morning, Jordan.");
    expect(email.html).toContain("9:00 AM–10:00 AM · Bella (11 yr Labrador)");
    expect(email.html).toContain("12 Palm Way, Tampa, FL 33602");
    expect(email.html).toContain(">Directions</a>");
    expect(email.html).toContain("Penicillin (severe)");
    expect(email.html).toContain('href="https://vpm.example/encounters/a1"');
    expect(email.html).toContain("2 unread client messages");
    // Clinical text is escaped, never injected as markup.
    expect(email.html).toContain("&lt;follow-up&gt;");
    expect(email.html).not.toContain("<follow-up>");
  });

  it("says when the day is clear", () => {
    const email = renderMorningBriefingEmail({
      practiceName: "Clinic",
      recipientName: "",
      day: day(),
      todo: emptyTodo(),
      baseUrl: null,
    });
    expect(email.html).toContain("No visits on the schedule today.");
    expect(email.html).toContain("Nothing waiting.");
    expect(todoItemCount(emptyTodo())).toBe(0);
  });
});

describe("morning briefing wiring", () => {
  it("claims each send under a practice lock and marks the day before emailing", () => {
    const source = readFileSync("lib/agent/morning-briefing.ts", "utf8");
    const lock = source.indexOf('.for("update")');
    const mark = source.indexOf("jsonb_set(");
    const send = source.indexOf("await sendEmail(");
    expect(lock).toBeGreaterThan(0);
    expect(mark).toBeGreaterThan(lock);
    expect(send).toBeGreaterThan(mark);
    expect(source).toContain("idempotencyKey: `morning-briefing:");
  });

  it("only lets administrators manage other people or the send time", () => {
    const router = readFileSync("server/routers/agent.ts", "utf8");
    expect(router).toContain(
      'if (!isAdmin && (input.userId !== ctx.user.id || input.hour !== undefined))',
    );
    expect(router).toContain("inArray(users.role, [...MORNING_BRIEFING_ROLES])");
  });

  it("is scheduled hourly on hosted and on the self-host server", () => {
    const vercel = readFileSync("vercel.json", "utf8");
    expect(vercel).toContain('"/api/cron/morning-briefing"');
    const cron = readFileSync("../../deploy/zenpaws/cron.sh", "utf8");
    expect(cron).toContain("install_job morning-briefing");
    expect(cron).toContain("-H @-");
    const update = readFileSync("../../deploy/zenpaws/update.sh", "utf8");
    expect(update).toContain("CRON_SECRET=$(openssl rand -hex 32)");
    expect(update).toContain("bash /opt/openvpm/deploy/zenpaws/cron.sh");
  });
});
