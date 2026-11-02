// Each TestFlight build runs on a fresh GitHub runner, so Xcode's automatic
// signing creates a new Apple Development certificate every time. Apple allows
// only a few per team, and once they run out the build fails with "Your
// account has reached the maximum number of certificates".
//
// This revokes the development certificates earlier builds created through
// the App Store Connect API (Apple names them "Created via API"). It never
// touches distribution certificates or certificates made in Xcode on a Mac.
// Revoking a development certificate does not affect apps already on
// TestFlight or the App Store. Uses the same App Store Connect API key as the
// upload workflow; never prints it.
import { createSign } from "node:crypto";

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

const DEVELOPMENT_TYPES = new Set(["DEVELOPMENT", "IOS_DEVELOPMENT"]);

export function isCiDevelopmentCertificate(certificate) {
  const attributes = certificate?.attributes ?? {};
  return (
    DEVELOPMENT_TYPES.has(attributes.certificateType) &&
    /created via api/i.test(attributes.displayName ?? "")
  );
}

const listed = await api("/v1/certificates?limit=200");
if (!listed.ok) {
  console.log(`Note: could not list certificates (HTTP ${listed.status}); continuing.`);
  process.exit(0);
}
const stale = (listed.body.data ?? []).filter(isCiDevelopmentCertificate);
let revoked = 0;
for (const certificate of stale) {
  const result = await api(`/v1/certificates/${certificate.id}`, { method: "DELETE" });
  if (result.ok || result.status === 404) revoked += 1;
  else console.log(`Note: could not revoke a CI development certificate (HTTP ${result.status}).`);
}
console.log(`Revoked ${revoked} development certificate(s) left by earlier builds.`);
