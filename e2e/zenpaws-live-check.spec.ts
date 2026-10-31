import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

/**
 * Read-only end-to-end check of a live OpenVPM server using the test logins
 * from deploy/zenpaws/create-test-users.sh. Signs in as each test login,
 * opens every main screen, and records HTTP status, error screens and
 * browser errors to a JSON summary with a screenshot per screen. It never
 * submits a booking, message or payment.
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
};
const TECH = {
  email: process.env.LIVE_TECH_EMAIL ?? "test-tech@zenpawsdvm.test",
  password: process.env.LIVE_TECH_PASSWORD ?? "",
};
const CLIENT = {
  login: process.env.LIVE_CLIENT_USERNAME ?? "zp-test-client",
  password: process.env.LIVE_CLIENT_PASSWORD ?? "",
};
const TEST_PET = "Biscuit (test)";

type Check = {
  who: string;
  name: string;
  url: string;
  status: number | string;
  ok: boolean;
  problems: string[];
  shot: string;
};

const checks: Check[] = [];

test.use({ baseURL: BASE, viewport: { width: 1366, height: 900 } });
test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  fs.mkdirSync(OUT, { recursive: true });
});

test.afterAll(() => {
  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(checks, null, 2));
});

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(`page error: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console: ${msg.text().slice(0, 300)}`);
  });
  return errors;
}

async function visit(
  page: Page,
  errors: string[],
  who: string,
  name: string,
  route: string,
  expectText?: RegExp | string,
): Promise<Check> {
  errors.length = 0;
  const problems: string[] = [];
  let status: number | string = "no response";
  try {
    const res = await page.goto(route, { waitUntil: "domcontentloaded", timeout: 45_000 });
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
  if (expectText) {
    const found = await page.getByText(expectText).first().isVisible().catch(() => false);
    if (!found) problems.push(`expected to see ${String(expectText)}`);
  }
  problems.push(...errors);
  const shot = `${who}-${name}.png`.replace(/[^a-z0-9.-]+/gi, "-").toLowerCase();
  await page.screenshot({ path: path.join(OUT, shot), fullPage: true }).catch(() => {});
  const check = { who, name, url: page.url(), status, ok: problems.length === 0, problems, shot };
  checks.push(check);
  return check;
}

async function staffSignIn(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });
}

test("signed-out pages load", async ({ page }) => {
  const errors = watchErrors(page);
  await visit(page, errors, "guest", "staff-sign-in", "/login");
  await visit(page, errors, "guest", "portal-sign-in", "/portal", /apple/i);
  await visit(page, errors, "guest", "online-booking", "/book");
  expect(checks.filter((c) => c.who === "guest" && !c.ok)).toEqual([]);
});

test("portal rejects a wrong password", async ({ page }) => {
  await page.goto("/portal");
  await page.getByLabel("Username or email").fill(CLIENT.login);
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible({ timeout: 15_000 });
});

test("client portal works for the test client", async ({ page }) => {
  test.skip(!CLIENT.password, "LIVE_CLIENT_PASSWORD not set");
  const errors = watchErrors(page);
  await page.goto("/portal");
  await page.getByLabel("Username or email").fill(CLIENT.login);
  await page.getByLabel("Password").fill(CLIENT.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText(TEST_PET).first()).toBeVisible({ timeout: 30_000 });

  await visit(page, errors, "client", "home", "/portal", TEST_PET);
  await visit(page, errors, "client", "pets", "/portal/pets", TEST_PET);
  await page.getByText(TEST_PET).first().click().catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await visit(page, errors, "client", "pet-detail", page.url().replace(BASE, "") || "/portal/pets");
  await visit(page, errors, "client", "appointments", "/portal/appointments");
  await visit(page, errors, "client", "book", "/portal/book");
  await visit(page, errors, "client", "invoices", "/portal/invoices");
  await visit(page, errors, "client", "messages", "/portal/messages");
  await visit(page, errors, "client", "video", "/portal/video");
  await visit(page, errors, "client", "account", "/portal/account");
  expect(checks.filter((c) => c.who === "client" && !c.ok)).toEqual([]);
});

test("front desk can sign in and use the main screens", async ({ page }) => {
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

  // Find the test client and open the record and the pet's chart.
  await page.goto("/clients");
  const search = page.getByPlaceholder(/search/i).first();
  if (await search.isVisible().catch(() => false)) await search.fill("Tester");
  await page.getByText(/Tester \(test\)/).first().click({ timeout: 20_000 });
  await page.waitForURL(/\/clients\/[0-9a-f-]{36}/, { timeout: 20_000 });
  await visit(page, errors, "front-desk", "test-client-record", page.url().replace(BASE, ""), TEST_PET);
  await page.getByText(TEST_PET).first().click({ timeout: 20_000 });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await visit(page, errors, "front-desk", "test-pet-chart", page.url().replace(BASE, ""), TEST_PET);
  expect(checks.filter((c) => c.who === "front-desk" && !c.ok)).toEqual([]);
});

test("technician can sign in and see patients", async ({ page }) => {
  test.skip(!TECH.password, "LIVE_TECH_PASSWORD not set");
  const errors = watchErrors(page);
  await staffSignIn(page, TECH.email, TECH.password);
  await visit(page, errors, "technician", "dashboard", "/");
  await visit(page, errors, "technician", "schedule", "/schedule");
  await visit(page, errors, "technician", "patients", "/patients");
  await visit(page, errors, "technician", "whiteboard", "/whiteboard");
  expect(checks.filter((c) => c.who === "technician" && !c.ok)).toEqual([]);
});
