// Video visits embed the clinic's own Daily (daily.co) room. Only that exact
// origin may be framed or use the camera and microphone, and only when
// DAILY_DOMAIN is configured (it must be set before the app is built).
const dailyDomain = (process.env.DAILY_DOMAIN || "").trim().toLowerCase();
const videoOrigin = /^[a-z0-9-]{1,63}$/.test(dailyDomain)
  ? `https://${dailyDomain}.daily.co`
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
  "connect-src 'self' https://app.openvpm.com https://vitals.vercel-insights.com https://va.vercel-scripts.com",
  "worker-src 'self' blob:",
  videoOrigin ? `frame-src 'self' ${videoOrigin}` : null,
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
    // The house-call visit recorder uses this origin's own microphone (after
    // the client consents); embedded third-party frames stay blocked.
    key: "Permissions-Policy",
    value: [
      videoOrigin ? `camera=(self "${videoOrigin}")` : "camera=()",
      videoOrigin ? `microphone=(self "${videoOrigin}")` : "microphone=(self)",
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
