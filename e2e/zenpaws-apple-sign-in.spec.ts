import { test, expect, type Page } from "@playwright/test";

/**
 * Sign in with Apple on the live client portal, including someone signing in
 * for the first time with an Apple ID the clinic has never seen.
 *
 * The first two checks run on their own: the "Continue with Apple" button
 * sends the browser to Apple with this server's settings, and a forged answer
 * from "Apple" is turned away. Neither one reaches Apple or changes anything.
 *
 * The new-account check needs a person, because Apple asks for the Apple ID
 * password and a code from a trusted device. Run it in a visible browser and
 * sign in with an Apple ID that has never used the ZenPaws portal (or one you
 * removed under Apple ID settings > Sign in with Apple > ZenPaws). It passes
 * when the portal opens signed in to a new account. That account stays; a
 * clinic admin can archive it afterwards.
 *
 *   LIVE_BASE_URL=https://app.zenpawsdvm.com \
 *   pnpm exec playwright test -c playwright.zenpaws-apple.config.ts
 *
 *   # with the new-account check (a browser window opens; you have 5 minutes):
 *   LIVE_APPLE_NEW_ACCOUNT=1 pnpm exec playwright test -c playwright.zenpaws-apple.config.ts --headed
 */

const BASE = process.env.LIVE_BASE_URL ?? "";
const APPLE_SERVICES_ID = process.env.LIVE_APPLE_SERVICES_ID ?? "com.zenpawsdvm.web";
const MANUAL = process.env.LIVE_APPLE_NEW_ACCOUNT === "1";

// Only against a live server someone named on purpose, never in the default e2e run.
test.skip(!BASE, "set LIVE_BASE_URL to the live server to run these checks");

async function openSignIn(page: Page) {
  await page.goto(`${BASE}/portal/account`);
  const apple = page.getByRole("link", { name: "Continue with Apple" }).filter({ visible: true }).first();
  await expect(apple, "the portal sign-in page offers Continue with Apple").toBeVisible({ timeout: 60_000 });
  return apple;
}

test("Continue with Apple sends the browser to Apple with this server's settings", async ({ page }) => {
  const apple = await openSignIn(page);
  // Where the button sends the browser (we only open Apple's page, never sign in there).
  const toApple = page.waitForRequest((request) => request.url().startsWith("https://appleid.apple.com/"), {
    timeout: 30_000,
  });
  await apple.click();
  const authorize = new URL((await toApple).url());
  expect(authorize.pathname).toBe("/auth/authorize");

  const query = authorize.searchParams;
  expect(query.get("client_id")).toBe(APPLE_SERVICES_ID);
  expect(query.get("redirect_uri")).toBe(`${BASE}/api/portal/sso/apple/callback`);
  expect(query.get("response_mode")).toBe("form_post");
  // Asking for the name and email is what lets a first sign-in name the new account.
  expect(query.get("scope")?.split(" ").sort()).toEqual(["email", "name"]);
  expect(query.get("state")).toMatch(/^[\w-]{20,}$/);
  expect(query.get("nonce")).toMatch(/^[\w-]{20,}$/);
});

test("a forged answer from Apple is turned away without signing anyone in", async ({ page }) => {
  // Post the way Apple does, but without the sign-in this browser started.
  const response = await page.request.post(`${BASE}/api/portal/sso/apple/callback`, {
    form: { state: "forged", id_token: "not.a.token" },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(303);
  expect(new URL(response.headers().location!).searchParams.get("sso_error")).toBe("expired");
  expect(response.headers()["set-cookie"] ?? "").not.toContain("portal_session");
});

test("a new Apple ID gets a client portal account", async ({ page }) => {
  test.skip(!MANUAL, "needs a person to sign in at Apple: set LIVE_APPLE_NEW_ACCOUNT=1 and run with --headed");
  test.setTimeout(6 * 60_000);

  const apple = await openSignIn(page);
  await apple.click();
  await expect(page).toHaveURL(/appleid\.apple\.com/, { timeout: 30_000 });
  console.log("\n>>> Sign in with a NEW Apple ID in the browser window, then wait. You have 5 minutes.\n");

  // Back from Apple: either inside the portal or on the sign-in page with a reason.
  await page.waitForURL((url) => url.host === new URL(BASE).host, { timeout: 5 * 60_000 });
  await page.waitForLoadState("domcontentloaded");
  const error = new URL(page.url()).searchParams.get("sso_error");
  expect(error, `Apple sign-in came back with sso_error=${error}`).toBeNull();

  // Signed in: the account page shows the new client's own details.
  await page.goto(`${BASE}/portal/account`);
  const details = page
    .locator("section")
    .filter({ hasText: "To change these details, send the clinic a message." })
    .filter({ visible: true })
    .first();
  await expect(details, "the portal opens signed in to an account").toBeVisible({ timeout: 60_000 });
  console.log(`New portal account: ${(await details.innerText()).split("\n").slice(0, 2).join(" · ")}`);

  // Signing out and in again with the same Apple ID would reuse this account;
  // that path is covered by the database tests in
  // apps/web/lib/portal/__tests__/identity-sign-in.integration.test.ts.
});
