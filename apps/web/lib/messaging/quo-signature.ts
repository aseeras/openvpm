import { createHmac, timingSafeEqual } from "node:crypto";

/** Quo signs webhooks with the Standard Webhooks scheme (`whsec_` secrets). */
export const QUO_WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

function signingKey(secret: string): Buffer | null {
  const trimmed = secret.trim();
  const encoded = trimmed.startsWith("whsec_") ? trimmed.slice(6) : trimmed;
  if (!encoded) return null;
  const key = Buffer.from(encoded, "base64");
  return key.length > 0 ? key : null;
}

export function quoWebhookSignature(opts: {
  secret: string;
  webhookId: string;
  timestamp: string;
  rawBody: string;
}): string | null {
  const key = signingKey(opts.secret);
  if (!key) return null;
  return createHmac("sha256", key)
    .update(`${opts.webhookId}.${opts.timestamp}.${opts.rawBody}`)
    .digest("base64");
}

/**
 * Verify `webhook-id`, `webhook-timestamp`, and `webhook-signature` against the
 * raw request body. The signature header may hold several space-separated
 * `v1,<base64>` entries during secret rotation; any one match is enough.
 */
export function verifyQuoWebhook(opts: {
  secret: string | undefined;
  headers: Headers;
  rawBody: string;
  nowMs?: number;
}): boolean {
  const webhookId = opts.headers.get("webhook-id")?.trim();
  const timestamp = opts.headers.get("webhook-timestamp")?.trim();
  const signatureHeader = opts.headers.get("webhook-signature")?.trim();
  if (!opts.secret || !webhookId || !timestamp || !signatureHeader) {
    return false;
  }
  if (!/^\d{1,12}$/.test(timestamp)) return false;
  const nowSeconds = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  if (
    Math.abs(nowSeconds - Number(timestamp)) > QUO_WEBHOOK_TOLERANCE_SECONDS
  ) {
    return false;
  }

  const expected = quoWebhookSignature({
    secret: opts.secret,
    webhookId,
    timestamp,
    rawBody: opts.rawBody,
  });
  if (!expected) return false;
  const expectedBytes = Buffer.from(expected);

  return signatureHeader.split(/\s+/).some((entry) => {
    const [version, signature] = entry.split(",", 2);
    if (version !== "v1" || !signature) return false;
    const candidate = Buffer.from(signature);
    return (
      candidate.length === expectedBytes.length &&
      timingSafeEqual(candidate, expectedBytes)
    );
  });
}
