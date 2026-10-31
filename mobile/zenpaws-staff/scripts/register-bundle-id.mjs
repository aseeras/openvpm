// Registers the staff app's bundle ID with Apple (so it can be picked when
// creating the App Store Connect app) and turns on Associated Domains, which
// the app uses for saved-password autofill, and Sign in with Apple. Safe to
// run repeatedly. Uses the same App Store Connect API key as the upload
// workflow; never prints it.
import { createSign } from "node:crypto";

const BUNDLE_ID = process.env.BUNDLE_ID ?? "com.zenpawsdvm.staff";
const APP_NAME = "ZenPaws VPM";
const { ASC_KEY_ID, ASC_ISSUER_ID, ASC_PRIVATE_KEY } = process.env;
if (!ASC_KEY_ID || !ASC_ISSUER_ID || !ASC_PRIVATE_KEY) {
  console.error("Missing App Store Connect API key secrets.");
  process.exit(1);
}

const base64url = (value) => Buffer.from(value).toString("base64url");
function token() {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "ES256", kid: ASC_KEY_ID, typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({ iss: ASC_ISSUER_ID, iat: now, exp: now + 600, aud: "appstoreconnect-v1" }),
  );
  const signer = createSign("SHA256");
  signer.update(`${header}.${payload}`);
  const signature = signer.sign({ key: ASC_PRIVATE_KEY, dsaEncoding: "ieee-p1363" });
  return `${header}.${payload}.${base64url(signature)}`;
}

async function api(path, init = {}) {
  const response = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
  });
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body };
}

const found = await api(`/v1/bundleIds?filter[identifier]=${encodeURIComponent(BUNDLE_ID)}&limit=5`);
if (!found.ok) {
  console.error(`Could not read bundle IDs (HTTP ${found.status}).`);
  process.exit(1);
}
let bundle = found.body.data?.find((item) => item.attributes?.identifier === BUNDLE_ID);
if (!bundle) {
  const created = await api("/v1/bundleIds", {
    method: "POST",
    body: JSON.stringify({
      data: { type: "bundleIds", attributes: { identifier: BUNDLE_ID, name: APP_NAME, platform: "IOS" } },
    }),
  });
  if (!created.ok) {
    console.error(`Could not register ${BUNDLE_ID} (HTTP ${created.status}): ${JSON.stringify(created.body.errors?.[0]?.detail ?? "")}`);
    process.exit(1);
  }
  bundle = created.body.data;
  console.log(`Registered bundle ID ${BUNDLE_ID}.`);
} else {
  console.log(`Bundle ID ${BUNDLE_ID} is registered.`);
}

async function turnOn(capabilityType, label, settings) {
  const result = await api("/v1/bundleIdCapabilities", {
    method: "POST",
    body: JSON.stringify({
      data: {
        type: "bundleIdCapabilities",
        attributes: settings ? { capabilityType, settings } : { capabilityType },
        relationships: { bundleId: { data: { type: "bundleIds", id: bundle.id } } },
      },
    }),
  });
  // 409 means it was already on.
  if (result.ok || result.status === 409) console.log(`${label} is on.`);
  else console.log(`Note: could not turn on ${label} (HTTP ${result.status}); Xcode will try during signing.`);
}

await turnOn("ASSOCIATED_DOMAINS", "Associated Domains");
// Sign in with Apple, as its own primary app (not grouped with another app).
await turnOn("APPLE_ID_AUTH", "Sign in with Apple", [
  { key: "APPLE_ID_AUTH_APP_CONSENT", options: [{ key: "PRIMARY_APP_CONSENT" }] },
]);
