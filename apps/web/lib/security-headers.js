// Video visits are direct WebRTC calls between browsers. The only extra host
// the page talks to is the clinic's Amazon Kinesis Video Streams signaling
// endpoint in its own region; media flows peer to peer (or through Amazon's
// TURN relay), which the content security policy does not govern. These
// values are read when the app is built, so rebuild after changing them.
function env(name) {
  return (process.env[name] || "").trim();
}
const videoRegion =
  env("TELEHEALTH_VIDEO") === "aws_kvs"
    ? env("TELEHEALTH_VIDEO_REGION") ||
      env("VISIT_RECORDING_TRANSCRIBE_REGION") ||
      env("S3_REGION")
    : "";
const videoEnabled = /^[a-z0-9-]{4,32}$/.test(videoRegion);
// A local stand-in for the signaling service, used only by tests.
const videoTestOrigin = (() => {
  try {
    const url = new URL(env("KVS_ENDPOINT"));
    return `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`;
  } catch {
    return null;
  }
})();
const videoConnectHosts = videoEnabled
  ? [`wss://*.kinesisvideo.${videoRegion}.amazonaws.com`, videoTestOrigin]
      .filter(Boolean)
      .join(" ")
  : null;

const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  [
    "script-src 'self' 'unsafe-inline'",
    process.env.NODE_ENV === "development" ? "'unsafe-eval'" : null,
    "https://va.vercel-scripts.com",
  ]
    .filter(Boolean)
    .join(" "),
  [
    "connect-src 'self' https://app.openvpm.com https://vitals.vercel-insights.com https://va.vercel-scripts.com",
    videoConnectHosts,
  ]
    .filter(Boolean)
    .join(" "),
  "worker-src 'self' blob:",
  process.env.NODE_ENV === "production" ? "upgrade-insecure-requests" : null,
]
  .filter(Boolean)
  .join("; ");

const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: contentSecurityPolicy,
  },
  {
    key: "X-Content-Type-Options",
    value: "nosniff",
  },
  {
    key: "X-Frame-Options",
    value: "DENY",
  },
  {
    key: "X-XSS-Protection",
    value: "1; mode=block",
  },
  {
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  {
    // The house-call visit recorder and video visits use this origin's own
    // camera and microphone (after the person allows it); embedded
    // third-party frames stay blocked.
    key: "Permissions-Policy",
    value: [
      videoEnabled ? "camera=(self)" : "camera=()",
      "microphone=(self)",
      "geolocation=()",
      "payment=()",
      "usb=()",
      "interest-cohort=()",
    ].join(", "),
  },
];

const capabilityHeaders = [
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
  { key: "Cache-Control", value: "private, no-store, max-age=0" },
];

function applyHeaders(response, headers) {
  for (const { key, value } of headers) {
    response.headers.set(key, value);
  }
  return response;
}

function applySecurityHeaders(response) {
  return applyHeaders(response, securityHeaders);
}

function applyCapabilitySecurityHeaders(response) {
  applySecurityHeaders(response);
  return applyHeaders(response, capabilityHeaders);
}

module.exports = {
  applyCapabilitySecurityHeaders,
  capabilityHeaders,
  contentSecurityPolicy,
  securityHeaders,
  applySecurityHeaders,
};
