import { portalSessions } from "@openpims/db";
import type { Database } from "@openpims/db/client";
import {
  generatePortalSessionToken,
  hashPortalRequestMetadata,
  hashPortalSessionToken,
} from "./tokens";
import { portalSessionExpiresAt } from "./session";

/** Start a portal session for a client; returns the raw cookie credential. */
export async function insertPortalSession(
  tx: Database,
  input: {
    practiceId: string;
    clientId: string;
    ip: string;
    userAgent: string | null;
    now: Date;
  },
): Promise<string> {
  const rawSessionToken = generatePortalSessionToken();
  await tx.insert(portalSessions).values({
    practiceId: input.practiceId,
    clientId: input.clientId,
    tokenHash: hashPortalSessionToken(rawSessionToken),
    lastSeenAt: input.now,
    expiresAt: portalSessionExpiresAt(input.now),
    createdIpHash: hashPortalRequestMetadata(input.ip),
    userAgentHash: hashPortalRequestMetadata(input.userAgent),
  });
  return rawSessionToken;
}
