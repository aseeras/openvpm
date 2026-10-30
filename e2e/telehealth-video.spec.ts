import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { startMockKvs, type MockKvs } from "./fixtures/mock-kvs";

// A whole video visit in two real browsers with fake cameras: the client
// waits, the clinician starts the call, both see and hear each other over
// WebRTC, the client agrees to a transcript and the clinician's browser
// records it, the client reloads mid-call and reconnects, and the visit ends
// with the client's summary. Amazon's signaling service is replaced by a
// local stand-in (fixtures/mock-kvs.ts); the call media is real WebRTC.
//
// The upload of the recorded audio is intercepted in the browser, so nothing
// reaches Amazon Transcribe. Run only against a fresh local server on a
// disposable seeded database (a slow first compile may need the server
// started beforehand; it is reused):
//   createdb openvpm_telehealth_e2e_1 && DATABASE_URL=... pnpm db:migrate && pnpm db:rls && pnpm db:seed
//   TELEHEALTH_E2E=1 DATABASE_URL=postgres://.../openvpm_telehealth_e2e_1 \
//   TELEHEALTH_E2E_DATABASE_URL=postgres://.../openvpm_telehealth_e2e_1 \
//   TELEHEALTH_VIDEO=aws_kvs TELEHEALTH_VIDEO_REGION=us-east-2 \
//   KVS_ENDPOINT=http://127.0.0.1:4011 S3_ACCESS_KEY=test S3_SECRET_KEY=test \
//   VISIT_RECORDING_TRANSCRIPTION=aws_transcribe S3_BUCKET=test-bucket S3_REGION=us-east-2 \
//   PLAYWRIGHT_BASE_URL=http://localhost:3502 \
//   PLAYWRIGHT_WEB_SERVER_COMMAND="pnpm --filter @openpims/web exec next dev -p 3502" \
//   pnpm exec playwright test e2e/telehealth-video.spec.ts --workers=1
const enabled = process.env.TELEHEALTH_E2E === "1";
const databaseUrl = process.env.TELEHEALTH_E2E_DATABASE_URL;
const clinicianEmail =
  process.env.TELEHEALTH_E2E_EMAIL ?? "sarah.chen@neighborhoodvet.example.com";
const clinicianPassword = process.env.TELEHEALTH_E2E_PASSWORD ?? "password123";
const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

if (enabled) {
  if (!databaseUrl || process.env.DATABASE_URL !== databaseUrl) {
    throw new Error("DATABASE_URL must exactly match TELEHEALTH_E2E_DATABASE_URL");
  }
  const db = new URL(databaseUrl);
  const web = new URL(process.env.PLAYWRIGHT_BASE_URL ?? "http://invalid.test");
  const kvs = new URL(process.env.KVS_ENDPOINT ?? "http://invalid.test");
  if (!localHosts.has(db.hostname) || !localHosts.has(web.hostname) || !localHosts.has(kvs.hostname)) {
    throw new Error("Video visit E2E requires local database, web and signaling hosts");
  }
  if (!/^openvpm_telehealth_e2e_[a-zA-Z0-9_]+$/.test(db.pathname.slice(1))) {
    throw new Error("Video visit E2E requires an openvpm_telehealth_e2e_ disposable database");
  }
  if (process.env.TELEHEALTH_VIDEO !== "aws_kvs") {
    throw new Error("Start the server with TELEHEALTH_VIDEO=aws_kvs and KVS_ENDPOINT set");
  }
}

test.skip(!enabled, "Set TELEHEALTH_E2E=1 with an isolated synthetic database");
test.describe.configure({ mode: "serial" });

const suffix = randomUUID().slice(0, 8);
const client = {
  username: `video-e2e-${suffix}`,
  password: `Synthetic-${suffix}-pass`,
  firstName: "Synthetic",
  lastName: `Owner ${suffix}`,
  petName: `Biscuit ${suffix}`,
};
let kvs: MockKvs;
const browsers: Browser[] = [];

test.beforeAll(async () => {
  if (!enabled) return;
  kvs = await startMockKvs(Number(new URL(process.env.KVS_ENDPOINT!).port));

  const require = createRequire(path.resolve("apps/web/package.json"));
  const bcrypt = require("bcryptjs") as { hash: (value: string, rounds: number) => Promise<string> };
  const sql = require("postgres")(databaseUrl, { max: 1 });
  try {
    const [staff] = await sql`
      select practice_id from users where email = ${clinicianEmail} and deleted_at is null`;
    expect(staff, "Seeded clinician must exist").toBeTruthy();
    const practiceId = staff.practice_id as string;
    // A client with an app account and a pet seen in person before.
    const [owner] = await sql`
      insert into clients (practice_id, first_name, last_name, email)
      values (${practiceId}, ${client.firstName}, ${client.lastName}, ${`${client.username}@example.invalid`})
      returning id`;
    await sql`
      insert into portal_accounts (practice_id, client_id, username, password_hash)
      values (${practiceId}, ${owner.id}, ${client.username}, ${await bcrypt.hash(client.password, 10)})`;
    const [pet] = await sql`
      insert into patients (practice_id, client_id, name, species)
      values (${practiceId}, ${owner.id}, ${client.petName}, 'canine')
      returning id`;
    const [location] = await sql`
      select id from locations where practice_id = ${practiceId} and deleted_at is null
      order by is_primary desc limit 1`;
    await sql`
      insert into appointments (practice_id, location_id, patient_id, client_id, start_time, end_time, status)
      values (${practiceId}, ${location.id}, ${pet.id}, ${owner.id},
        now() - interval '30 days', now() - interval '30 days' + interval '30 minutes', 'checked_out')`;
    // Clear any earlier run's open visits and take video visits.
    await sql`
      update telehealth_visits set status = 'cancelled', ended_at = now()
      where practice_id = ${practiceId} and status in ('waiting', 'in_call')`;
    await sql`
      update practices set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{telehealth}', '{"accepting": true}'::jsonb)
      where id = ${practiceId}`;
  } finally {
    await sql.end();
  }
});

test.afterAll(async () => {
  for (const browser of browsers) await browser.close();
  if (kvs) await kvs.close();
});

async function newPhone(width: number, height: number, mobile: boolean): Promise<Page> {
  // Chrome's built-in fake camera and microphone, allowed without a prompt.
  const browser = await chromium.launch({
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
    // A machine whose Chromium differs from this Playwright's can point at it.
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  });
  browsers.push(browser);
  const context = await browser.newContext({
    baseURL: process.env.PLAYWRIGHT_BASE_URL,
    viewport: { width, height },
    isMobile: mobile,
    hasTouch: mobile,
  });
  await context.addInitScript(() => {
    localStorage.setItem("openvpm.cookie-consent.v1", "essential");
    sessionStorage.setItem("ovpm_verify_email_dismissed", "1");
  });
  return context.newPage();
}

/** The other person's video, playing with real frames, and their audio. */
function remoteMedia(page: Page) {
  return page.evaluate(() => {
    const video = [...document.querySelectorAll("video")].find((element) => !element.muted);
    const stream = video?.srcObject as MediaStream | null | undefined;
    if (!video || !stream) return null;
    return {
      width: video.videoWidth,
      playing: video.currentTime > 0.3 && !video.paused,
      tracks: stream.getTracks().map((track) => `${track.kind}:${track.readyState}`).sort(),
    };
  });
}

async function expectConnected(page: Page) {
  await expect
    .poll(() => remoteMedia(page), { timeout: 45_000, intervals: [500] })
    .toMatchObject({ playing: true, tracks: ["audio:live", "video:live"] });
  expect((await remoteMedia(page))!.width).toBeGreaterThan(0);
}

test("a client and clinician hold a video visit with a consented transcript", async () => {
  test.setTimeout(240_000);
  const vet = await newPhone(1440, 1000, false);
  const owner = await newPhone(390, 844, true);

  // The clinician signs in to the clinic system.
  await vet.goto("/login", { waitUntil: "networkidle" });
  await vet.getByLabel("Email").fill(clinicianEmail);
  await vet.getByLabel("Password").fill(clinicianPassword);
  await Promise.all([
    vet.waitForURL((url) => url.pathname !== "/login", { timeout: 60_000 }),
    vet.getByRole("button", { name: "Sign in", exact: true }).click(),
  ]);

  // The client signs in to the app and enters the waiting room.
  await owner.goto("/portal");
  const signIn = await owner.request.post("/api/portal/account", {
    data: { action: "sign_in", login: client.username, password: client.password },
  });
  expect(signIn.status()).toBe(200);
  await owner.goto("/portal/video");
  await owner.locator("label", { hasText: client.petName }).first().click();
  await owner.getByRole("button", { name: "Acupuncture follow-up" }).click();
  await owner.getByRole("button", { name: "Continue to waiting room" }).click();
  await expect(owner.getByText("Virtual waiting room")).toBeVisible({ timeout: 30_000 });

  // The clinician starts the visit; both sides connect.
  await vet.goto("/telehealth");
  await vet.getByRole("button", { name: "Start visit" }).first().click();
  await expectConnected(vet);
  await expectConnected(owner);
  expect(kvs.channels.size).toBe(1);

  // Transcript: the clinician asks, the client agrees, the call audio is
  // recorded in the clinician's browser and uploaded when the visit ends.
  let upload: { bytes: number; type: string } | null = null;
  await vet.route("**/api/telehealth/*/audio", async (route) => {
    upload = {
      bytes: route.request().postDataBuffer()?.length ?? 0,
      type: route.request().headers()["content-type"] ?? "",
    };
    await route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
  });
  await vet.getByRole("button", { name: "Transcribe visit" }).click();
  await expect(owner.getByText("Allow a transcript of this visit?")).toBeVisible({ timeout: 30_000 });
  await owner.getByRole("button", { name: "Allow transcript" }).click();
  await expect(owner.getByText("Transcript on")).toBeVisible({ timeout: 30_000 });
  await expect(vet.getByText("Recording audio for the transcript (client agreed)")).toBeVisible({
    timeout: 30_000,
  });

  // The client's page reloads mid-call: the call reconnects.
  await owner.waitForTimeout(3_000);
  await owner.reload();
  await expectConnected(owner);
  await expectConnected(vet);

  // Muting works, then the clinician ends the visit.
  await vet.getByRole("button", { name: "Mute microphone" }).click();
  await expect(vet.getByRole("button", { name: "Unmute microphone" })).toBeVisible();
  await vet.getByRole("button", { name: "End visit" }).click();
  await expect(owner.getByText("What happens next")).toBeVisible({ timeout: 30_000 });

  await expect.poll(() => upload, { timeout: 30_000 }).not.toBeNull();
  expect(upload!.type).toBe("audio/webm");
  expect(upload!.bytes).toBeGreaterThan(1_000);

  // Every control-plane call was signed, both sides used signed sockets,
  // and the visit's channel is gone.
  expect(kvs.log.filter((entry) => entry.includes("signed=false"))).toEqual([]);
  expect(kvs.log).toContain("socket master");
  expect(kvs.log.filter((entry) => entry === "socket viewer").length).toBeGreaterThanOrEqual(2);
  expect(kvs.log).not.toContain("socket rejected");
  expect(kvs.log).toContain("/deleteSignalingChannel signed=true");
  expect(kvs.channels.size).toBe(0);
});
