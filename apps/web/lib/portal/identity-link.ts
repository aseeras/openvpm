import { and, eq, isNull } from "drizzle-orm";
import { portalSignInIdentities } from "@openpims/db";
import type { Database } from "@openpims/db/client";
import type { ProviderIdentity, SignInProvider } from "./identity-sign-in";

export type LinkOutcome = "linked" | "taken";

/**
 * Connect an Apple or Google identity to a client who is already signed in,
 * so next time they can use it instead of a password or a link. An identity
 * already connected to someone else stays where it is.
 */
export async function linkProviderIdentity(
  tx: Database,
  input: {
    practiceId: string;
    clientId: string;
    provider: SignInProvider;
    identity: ProviderIdentity;
    now: Date;
  },
): Promise<LinkOutcome> {
  const { practiceId, clientId, provider, identity, now } = input;
  const [existing] = await tx
    .select({ clientId: portalSignInIdentities.clientId })
    .from(portalSignInIdentities)
    .where(
      and(
        eq(portalSignInIdentities.practiceId, practiceId),
        eq(portalSignInIdentities.provider, provider),
        eq(portalSignInIdentities.subject, identity.subject),
        isNull(portalSignInIdentities.deletedAt),
      ),
    )
    .limit(1);
  if (existing) return existing.clientId === clientId ? "linked" : "taken";
  await tx.insert(portalSignInIdentities).values({
    practiceId,
    clientId,
    provider,
    subject: identity.subject,
    email: identity.emailVerified ? identity.email : null,
    lastUsedAt: now,
  });
  return "linked";
}
