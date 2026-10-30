// Prints the TestFlight state of the latest builds of the ZenPaws VPM staff app,
// using the same App Store Connect API key as the upload workflow. Output goes
// to the log and, on GitHub Actions, to the run summary. Never prints the key.
import { createSign } from "node:crypto";
import { appendFileSync } from "node:fs";

const BUNDLE_ID = process.env.BUNDLE_ID ?? "com.zenpawsdvm.staff";
const { ASC_KEY_ID, ASC_ISSUER_ID, ASC_PRIVATE_KEY } = process.env;
if (!ASC_KEY_ID || !ASC_ISSUER_ID || !ASC_PRIVATE_KEY) {
  console.error("Missing App Store Connect API key secrets.");
  process.exit(1);
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

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

const auth = { Authorization: `Bearer ${token()}` };

async function api(path) {
  const response = await fetch(`https://api.appstoreconnect.apple.com${path}`, { headers: auth });
  if (!response.ok) {
    throw new Error(`App Store Connect returned HTTP ${response.status} for ${path.split("?")[0]}: ${(await response.text()).slice(0, 300)}`);
  }
  return response.json();
}

const apps = await api(`/v1/apps?filter[bundleId]=${encodeURIComponent(BUNDLE_ID)}&fields[apps]=name,bundleId`);
const app = apps.data?.[0];
if (!app) {
  console.log(`No App Store Connect app found for ${BUNDLE_ID}.`);
  process.exit(1);
}

const builds = await api(
  `/v1/builds?filter[app]=${app.id}&sort=-uploadedDate&limit=5` +
    `&fields[builds]=version,uploadedDate,processingState,expired,buildBetaDetail,preReleaseVersion` +
    `&include=buildBetaDetail,preReleaseVersion` +
    `&fields[buildBetaDetails]=internalBuildState,externalBuildState` +
    `&fields[preReleaseVersions]=version`,
);
const included = new Map((builds.included ?? []).map((item) => [`${item.type}:${item.id}`, item]));

const lines = [
  `### TestFlight status: ${app.attributes.name} (${BUNDLE_ID})`,
  "",
  "| Version | Build | Uploaded (UTC) | Processing | Internal testing | Expired |",
  "|---|---|---|---|---|---|",
];
for (const build of builds.data ?? []) {
  const detailRef = build.relationships?.buildBetaDetail?.data;
  const versionRef = build.relationships?.preReleaseVersion?.data;
  const detail = detailRef ? included.get(`${detailRef.type}:${detailRef.id}`) : null;
  const version = versionRef ? included.get(`${versionRef.type}:${versionRef.id}`) : null;
  lines.push(
    `| ${version?.attributes?.version ?? "?"} | ${build.attributes.version} | ` +
      `${build.attributes.uploadedDate ? new Date(build.attributes.uploadedDate).toISOString().replace("T", " ").slice(0, 16) : "?"} | ` +
      `${build.attributes.processingState} | ${detail?.attributes?.internalBuildState ?? "?"} | ` +
      `${build.attributes.expired ? "yes" : "no"} |`,
  );
}
if ((builds.data ?? []).length === 0) lines.push("| none yet | | | | | |");

const text = lines.join("\n");
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
