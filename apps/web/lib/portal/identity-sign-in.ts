import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { clients, portalSignInIdentities, practices } from "@openpims/db";
import type { Database } from "@openpims/db/client";
import { insertPortalSession } from "./create-session";
import { normalizeEmail, signUpPracticeId } from "./accounts";

export type SignInProvider = "apple" | "google";

export type ProviderIdentity = {
  subject: string;
  email: string | null;
  emailVerified: boolean;
};

/**
 * Start a portal session for someone Apple or Google has vouched for.
 *
 * 1. An identity already connected to a client signs that client in.
 * 2. The first time, a verified email matching exactly one client connects to it.
 * 3. Someone new gets a client record, like signing up with a password does
 *    (the provider has already confirmed the email).
 *
 * Returns the raw session cookie credential, or null when we can't tell which
 * client this is (no verified email, or several clients share it).
 */
export async function signInWithProviderIdentity(
  tx: Database,
  input: {
    provider: SignInProvider;
    identity: ProviderIdentity;
    givenName?: string;
    familyName?: string;
    ip: string;
    userAgent: string | null;
    now: Date;
  },
): Promise<string | null> {
  const { provider, identity, ip, userAgent, now } = input;

  const [linked] = await tx
    .select({
      identityId: portalSignInIdentities.id,
      clientId: portalSignInIdentities.clientId,
      practiceId: portalSignInIdentities.practiceId,
    })
    .from(portalSignInIdentities)
    .innerJoin(
      clients,
      and(
        eq(clients.id, portalSignInIdentities.clientId),
        eq(clients.practiceId, portalSignInIdentities.practiceId),
        isNull(clients.deletedAt),
      ),
    )
    .innerJoin(practices, and(eq(practices.id, portalSignInIdentities.practiceId), isNull(practices.deletedAt)))
    .where(
      and(
        eq(portalSignInIdentities.provider, provider),
        eq(portalSignInIdentities.subject, identity.subject),
        isNull(portalSignInIdentities.deletedAt),
      ),
    )
    .orderBy(desc(sql`coalesce(${portalSignInIdentities.lastUsedAt}, ${portalSignInIdentities.createdAt})`))
    .limit(1);
  if (linked) {
    await tx
      .update(portalSignInIdentities)
      .set({ lastUsedAt: now })
      .where(eq(portalSignInIdentities.id, linked.identityId));
    return insertPortalSession(tx, { ...linked, ip, userAgent, now });
  }

  if (!identity.emailVerified || !identity.email) return null;
  const email = normalizeEmail(identity.email);
  const matches = await tx
    .select({ id: clients.id, practiceId: clients.practiceId })
    .from(clients)
    .innerJoin(practices, and(eq(practices.id, clients.practiceId), isNull(practices.deletedAt)))
    .where(and(sql`lower(${clients.email}) = ${email}`, isNull(clients.deletedAt)))
    .limit(2);
  // Several clients share this email: don't guess which one it is.
  if (matches.length > 1) return null;
  let client = matches[0];
  if (!client) {
    const practiceId = await signUpPracticeId(tx);
    if (!practiceId) return null;
    const fallbackFirstName = provider === "apple" ? "Apple" : "Google";
    const [created] = await tx
      .insert(clients)
      .values({
        practiceId,
        firstName: input.givenName || fallbackFirstName,
        lastName: input.familyName || (input.givenName ? "" : "user"),
        email,
      })
      .returning({ id: clients.id, practiceId: clients.practiceId });
    client = created!;
  }
  await tx.insert(portalSignInIdentities).values({
    practiceId: client.practiceId,
    clientId: client.id,
    provider,
    subject: identity.subject,
    email: identity.email,
    lastUsedAt: now,
  });
  return insertPortalSession(tx, { practiceId: client.practiceId, clientId: client.id, ip, userAgent, now });
}
