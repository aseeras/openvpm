import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * End-to-end check of a live OpenVPM server using the test logins from
 * deploy/zenpaws/create-test-users.sh. Runs as the web app on a desktop
 * screen ("vpm-web") and on an iPhone screen ("iphone"), which is how the
 * ZenPaws staff and client iPhone apps show the same pages.
 *
 * What it covers:
 *   - sign-in for the front desk, technician and client portal logins
 *   - the test patient, Biscuit (test): staff chart, records and the client's
 *     pet page agree on who the pet is
 *   - lab results and assignments: the technician enters a lab result for the
 *     test patient and assigns its follow-up to the front desk, who sees it in
 *     their queue and records it as done
 *   - scheduling: the front desk books the test patient far in the future at
 *     06:00, outside clinic hours; the client sees it in the portal; the front
 *     desk then deletes it again
 *   - every main screen in both apps opens without an error
 *
 * It writes only to the test client and patient, never books a real
 * provider's slot, and never sends a message or takes a payment. Online
 * booking is opened but not submitted. The lab result stays in the test
 * patient's chart until create-test-users.sh --remove archives the patient.
 *
 *   LIVE_BASE_URL=https://app.zenpawsdvm.com \
 *   LIVE_FRONT_DESK_PASSWORD=... LIVE_TECH_PASSWORD=... LIVE_CLIENT_PASSWORD=... \
 *   pnpm exec playwright test -c playwright.zenpaws-live.config.ts
 */

const BASE = process.env.LIVE_BASE_URL ?? "https://app.zenpawsdvm.com";
const OUT = path.resolve(__dirname, "../outputs/zenpaws-live");
const FRONT_DESK = {
  email: process.env.LIVE_FRONT_DESK_EMAIL ?? "test-frontdesk@zenpawsdvm.test",
  password: process.env.LIVE_FRONT_DESK_PASSWORD ?? "",
  name: "Front Desk (test)",
};
const TECH = {
  email: process.env.LIVE_TECH_EMAIL ?? "test-tech@zenpawsdvm.test",
  password: process.env.LIVE_TECH_PASSWORD ?? "",
};
const CLIENT = {
  login: process.env.LIVE_CLIENT_USERNAME ?? "zp-test-client",
  password: process.env.LIVE_CLIENT_PASSWORD ?? "",
};
const TEST_CLIENT = /Tester \(test\)/;
const TEST_PET = "Biscuit (test)";
const TEST_BREED = "Beagle";
const RUN = new Date().toISOString().slice(0, 16).replace("T", " ");
const LAB_TEST_NAME = `Test CBC (e2e ${RUN})`;
const APPOINTMENT_NOTE = `E2E test booking ${RUN} - safe to ignore, deleted by the test`;

type Check = {
  app: string;
  who: string;
  name: string;
  url: string;
  status: number | string;
  ok: boolean;
  problems: string[];
  shot: string;
};

const checks: Check[] = [];
// Shared between the serial steps of one project run.
const state: { patientId?: string; labResultId?: string; appointmentId?: string } = {};

test.use({ baseURL: BASE });
test.describe.configure({ mode: "serial" });

test.beforeAll(({}, info) => {
  fs.mkdirSync(path.join(OUT, info.project.name), { recursive: true });
});

test.afterAll(({}, info) => {
  fs.writeFileSync(
    path.join(OUT, info.project.name, "summary.json"),
    JSON.stringify(checks, null, 2),
  );
});

function isPhone(): boolean {
  return test.info().project.name === "iphone";
}

// For rehearsals on a machine whose network blocks some outside hosts.
const IGNORE_CONSOLE = process.env.LIVE_IGNORE_CONSOLE
  ? new RegExp(process.env.LIVE_IGNORE_CONSOLE)
  : null;

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(`page error: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() !== "error" || IGNORE_CONSOLE?.test(msg.text())) return;
    errors.push(`console: ${msg.text().slice(0, 300)}`);
  });
  return errors;
}

function record(check: Omit<Check, "app">) {
  checks.push({ app: test.info().project.name, ...check });
}

async function visit(
  page: Page,
  errors: string[],
  who: string,
  name: string,
  route: string,
  expectText: (RegExp | string)[] = [],
): Promise<Check> {
  const problems: string[] = [];
  let status: number | string = "no response";
  try {
    const res = await page.goto(route, { waitUntil: "domcontentloaded", timeout: 45_000 });
    // Drop anything the previous page logged while it was being left.
    errors.length = 0;
    status = res?.status() ?? "no response";
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  } catch (err) {
    status = `navigation failed: ${(err as Error).message.split("\n")[0]}`;
  }
  if (typeof status !== "number" || status >= 400) problems.push(`HTTP ${status}`);
  if (await page.locator("#app-error-title").count()) problems.push("error screen shown");
  if (new URL(page.url()).pathname.startsWith("/login") && !route.startsWith("/login")) {
    problems.push("sent back to sign-in");
  }
  for (const text of expectText) {
    const found = await visibleText(page, text)
      .waitFor({ state: "visible", timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    if (!found) problems.push(`expected to see ${String(text)}`);
  }
  // Signed out, the app checks for a session and gets a 401; that is expected.
  problems.push(...errors.filter((e) => who !== "guest" || !/status of 401/.test(e)));
  const shot = path.join(
    test.info().project.name,
    `${who}-${name}.png`.replace(/[^a-z0-9.-]+/gi, "-").toLowerCase(),
  );
  await page.screenshot({ path: path.join(OUT, shot), fullPage: true }).catch(() => {});
  const check = { app: test.info().project.name, who, name, url: page.url(), status, ok: problems.length === 0, problems, shot };
  checks.push(check);
  return check;
}

/** Pages render separate phone and desktop layouts, so match only what is shown. */
function visibleText(page: Page, text: RegExp | string) {
  return page.getByText(text).filter({ visible: true }).first();
}

function failedFor(who: string) {
  return checks
    .filter((c) => c.app === test.info().project.name && c.who === who && !c.ok)
    .map((c) => `${c.name}: ${c.problems.join("; ")}`);
}

/** Calls the app's own API from inside the signed-in page, like the UI does. */
async function trpc<T>(page: Page, procedure: string, input: unknown, kind: "query" | "mutation"): Promise<T> {
  const res = await page.evaluate(
    async ({ procedure, input, kind }) => {
      const body = JSON.stringify({ json: input });
      const r =
        kind === "query"
          ? await fetch(`/api/trpc/${procedure}?input=${encodeURIComponent(body)}`)
          : await fetch(`/api/trpc/${procedure}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body,
            });
      return { status: r.status, text: await r.text() };
    },
    { procedure, input, kind },
  );
  let parsed: { result?: { data?: { json?: unknown } }; error?: { json?: { message?: string } } };
  try {
    parsed = JSON.parse(res.text);
  } catch {
    throw new Error(`${procedure}: HTTP ${res.status} ${res.text.slice(0, 200)}`);
  }
  if (res.status >= 400 || parsed.error) {
    throw new Error(`${procedure}: ${parsed.error?.json?.message ?? `HTTP ${res.status}`}`);
  }
  return parsed.result?.data?.json as T;
}

async function staffSignIn(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });
}

async function portalSignIn(page: Page, password = CLIENT.password) {
  // Signed out, the Account tab is the sign-in screen.
  await page.goto("/portal/account");
  await page.getByLabel("Username or email").fill(CLIENT.login);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

/** Opens the test client from the client list and then the test patient's chart. */
async function openTestPatient(page: Page, errors: string[], who: string) {
  await page.goto("/clients");
  const search = page.getByPlaceholder(/search/i).first();
  if (await search.isVisible().catch(() => false)) await search.fill("Tester");
  await visibleText(page, TEST_CLIENT).click({ timeout: 20_000 });
  await page.waitForURL(/\/clients\/[0-9a-f-]{36}/, { timeout: 20_000 });
  await visit(page, errors, who, "test-client-record", new URL(page.url()).pathname, [TEST_CLIENT, TEST_PET]);
  await visibleText(page, TEST_PET).click({ timeout: 20_000 });
  await page.waitForURL(/\/patients\/[0-9a-f-]{36}/, { timeout: 20_000 });
  state.patientId = new URL(page.url()).pathname.split("/")[2];
  await visit(page, errors, who, "test-patient-chart", new URL(page.url()).pathname, [TEST_PET, TEST_BREED, TEST_CLIENT]);
}

test.describe("signed out", () => {
  test("sign-in pages load and a wrong password is refused", async ({ page }) => {
    const errors = watchErrors(page);
    await visit(page, errors, "guest", "staff-sign-in", "/login");
    await visit(page, errors, "guest", "portal-home", "/portal", ["Sign in"]);
    await visit(page, errors, "guest", "portal-sign-in", "/portal/account", [
      "Username or email",
      // Sign in with Apple is on for app.zenpawsdvm.com; set LIVE_EXPECT_APPLE=0 elsewhere.
      ...(process.env.LIVE_EXPECT_APPLE === "0" ? [] : [/apple/i]),
    ]);
    if (process.env.LIVE_BOOKING_SLUG) {
      await visit(page, errors, "guest", "online-booking", `/book/${process.env.LIVE_BOOKING_SLUG}`);
    }
    expect(failedFor("guest")).toEqual([]);

    await portalSignIn(page, "not-the-password");
    await expect(page.getByRole("alert")).toBeVisible({ timeout: 15_000 });
  });
});

test.describe("technician: lab result and assignment", () => {
  test("enters a lab result for the test patient and assigns the follow-up", async ({ page }) => {
    test.skip(!TECH.password, "LIVE_TECH_PASSWORD not set");
    const errors = watchErrors(page);
    await staffSignIn(page, TECH.email, TECH.password);
    await visit(page, errors, "technician", "dashboard", "/");
    await visit(page, errors, "technician", "schedule", "/schedule");
    await visit(page, errors, "technician", "patients", "/patients");
    await visit(page, errors, "technician", "whiteboard", "/whiteboard");
    await openTestPatient(page, errors, "technician");

    if (!isPhone()) {
      const lab = await trpc<{ id: string }>(page, "records.createLabResult", {
        patientId: state.patientId,
        testName: LAB_TEST_NAME,
        resultValue: "42",
        unit: "%",
        referenceRangeLow: "37",
        referenceRangeHigh: "55",
        status: "completed",
        resultFlag: "normal",
        operationId: randomUUID(),
      }, "mutation");
      state.labResultId = lab.id;
      const assignees = await trpc<{ id: string; name: string }[]>(page, "records.listLabAssignees", undefined, "query");
      const frontDesk = assignees.find((a) => a.name === FRONT_DESK.name);
      expect(frontDesk, "front desk test login is assignable").toBeTruthy();
      await trpc(page, "records.assignLabFollowUp", {
        id: lab.id,
        assigneeId: frontDesk!.id,
        note: "E2E test: call the owner with the results (test patient, no real call needed).",
        operationId: randomUUID(),
      }, "mutation");
    }

    await visit(page, errors, "technician", "lab-results", "/lab-results");
    await visit(page, errors, "technician", "patient-lab-history",
      `/records?patientId=${state.patientId}&tab=labResults`,
      isPhone() ? [TEST_PET] : [LAB_TEST_NAME]);
    expect(failedFor("technician")).toEqual([]);
  });
});

test.describe("front desk: assignment, scheduling and the patient", () => {
  test("sees the assigned lab follow-up, books the test patient, and every screen opens", async ({ page }) => {
    test.skip(!FRONT_DESK.password, "LIVE_FRONT_DESK_PASSWORD not set");
    const errors = watchErrors(page);
    await staffSignIn(page, FRONT_DESK.email, FRONT_DESK.password);
    for (const [name, route] of [
      ["dashboard", "/"],
      ["schedule", "/schedule"],
      ["clients", "/clients"],
      ["patients", "/patients"],
      ["inbox", "/inbox"],
      ["billing", "/billing"],
      ["records", "/records"],
      ["telehealth", "/telehealth"],
      ["care-reminders", "/care-reminders"],
      ["recalls", "/recalls"],
      ["whiteboard", "/whiteboard"],
    ] as const) {
      await visit(page, errors, "front-desk", name, route);
    }
    await openTestPatient(page, errors, "front-desk");

    // Assignment: the technician's follow-up shows up in the front desk queue.
    if (state.labResultId) {
      await visit(page, errors, "front-desk", "assigned-lab-follow-up", "/lab-results",
        [`${TEST_PET} · ${LAB_TEST_NAME}`]);
      const card = page.locator("div", { hasText: LAB_TEST_NAME }).filter({
        has: page.getByRole("button", { name: "Complete follow-up" }),
      }).last();
      await card.getByRole("button", { name: "Complete follow-up" }).click();
      await page.getByLabel(/What was completed/).fill("E2E test: owner notified (test patient).");
      await page.getByRole("button", { name: "Record completion" }).click();
      await expect(page.getByText(`${TEST_PET} · ${LAB_TEST_NAME}`)).toHaveCount(0, { timeout: 20_000 });
    }

    // Scheduling: book the test patient at 06:00 about 90 days out.
    if (!isPhone()) {
      const start = new Date();
      start.setDate(start.getDate() + 90);
      start.setHours(6, 0, 0, 0);
      const end = new Date(start.getTime() + 30 * 60_000);
      const appt = await trpc<{ id: string }>(page, "appointments.create", {
        patientId: state.patientId,
        startTime: start.toISOString(),
        endTime: end.toISOString(),
        notes: APPOINTMENT_NOTE,
      }, "mutation");
      state.appointmentId = appt.id;
      const saved = await trpc<{ patientId: string | null; status: string }>(
        page, "appointments.getById", { id: appt.id }, "query");
      expect(saved.patientId).toBe(state.patientId);
      await visit(page, errors, "front-desk", "booked-appointment", `/patients/${state.patientId}`, [TEST_PET]);
    }
    expect(failedFor("front-desk")).toEqual([]);
  });
});

test.describe("client: portal", () => {
  test("signs in, sees the test patient and the new booking", async ({ page }) => {
    test.skip(!CLIENT.password, "LIVE_CLIENT_PASSWORD not set");
    const errors = watchErrors(page);
    await portalSignIn(page);
    await expect(page.getByLabel("Username or email")).toHaveCount(0, { timeout: 30_000 });

    await visit(page, errors, "client", "home", "/portal", [TEST_PET]);
    await visit(page, errors, "client", "pets", "/portal/pets", [TEST_PET]);
    await visibleText(page, TEST_PET).click().catch(() => {});
    await page.waitForURL(/\/portal\/pets\/[0-9a-f-]{36}/, { timeout: 20_000 }).catch(() => {});
    const petPath = new URL(page.url()).pathname;
    if (state.patientId && petPath.includes("/portal/pets/") && !petPath.endsWith(state.patientId)) {
      record({ who: "client", name: "same-patient", url: page.url(), status: "-", ok: false,
        problems: [`portal pet ${petPath} is not the staff chart's patient ${state.patientId}`], shot: "" });
    }
    await visit(page, errors, "client", "pet-detail", petPath, [TEST_PET, TEST_BREED]);
    await visit(page, errors, "client", "appointments", "/portal/appointments",
      state.appointmentId ? ["Upcoming and requests", "Scheduled", TEST_PET] : []);
    await visit(page, errors, "client", "book", "/portal/book");
    await visit(page, errors, "client", "invoices", "/portal/invoices");
    await visit(page, errors, "client", "messages", "/portal/messages");
    await visit(page, errors, "client", "video", "/portal/video");
    await visit(page, errors, "client", "account", "/portal/account");
    expect(failedFor("client")).toEqual([]);
  });
});

test.describe("clean up", () => {
  test("deletes the test booking", async ({ page }) => {
    test.skip(!state.appointmentId, "no test booking was made");
    await staffSignIn(page, FRONT_DESK.email, FRONT_DESK.password);
    await trpc(page, "appointments.delete", {
      id: state.appointmentId,
      reason: "E2E test booking, removed by the test",
    }, "mutation");
    const gone = await trpc<unknown>(page, "appointments.getById", { id: state.appointmentId }, "query")
      .then(() => false)
      .catch(() => true);
    expect(gone, "test booking was deleted").toBe(true);
  });
});
