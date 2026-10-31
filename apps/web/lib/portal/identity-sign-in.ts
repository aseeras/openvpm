import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
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
 * Start a portal session for someone Apple or Google has vouched for. Every
 * such sign-in ends up in a client portal account:
 *
 * 1. An identity already connected to a client signs that client in.
 * 2. The first time, a verified email matching exactly one client connects to it.
 * 3. Anyone else gets a new client portal account, like signing up with a
 *    password does. The provider has already confirmed who they are, so this
 *    works even when they chose not to share an email; an unverified email is
 *    never kept, so it can't be mistaken for a match later. When several
 *    clients share the email we don't guess between them: the new account
 *    stands on its own and the clinic can merge records later.
 *
 * An identity whose account was archived starts over with a new account.
 *
 * Returns the raw session cookie credential, or null only when the server has
 * no practice at all for the account to join.
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

  const email = identity.emailVerified && identity.email ? normalizeEmail(identity.email) : null;
  let client: { id: string; practiceId: string } | undefined;
  if (email) {
    const matches = await tx
      .select({ id: clients.id, practiceId: clients.practiceId })
      .from(clients)
      .innerJoin(practices, and(eq(practices.id, clients.practiceId), isNull(practices.deletedAt)))
      .where(and(sql`lower(${clients.email}) = ${email}`, isNull(clients.deletedAt)))
      .limit(2);
    if (matches.length === 1) client = matches[0];
  }
  if (!client) {
    const practiceId = (await signUpPracticeId(tx)) ?? (await oldestPracticeId(tx));
    if (!practiceId) {
      console.warn(`[portal-sso] ${provider} sign-in can't create an account: this server has no practice`);
      return null;
    }
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
  // A connection left behind by an archived account would block the new one.
  await tx
    .update(portalSignInIdentities)
    .set({ deletedAt: now })
    .where(
      and(
        eq(portalSignInIdentities.practiceId, client.practiceId),
        eq(portalSignInIdentities.provider, provider),
        eq(portalSignInIdentities.subject, identity.subject),
        isNull(portalSignInIdentities.deletedAt),
      ),
    );
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

/**
 * Where a new account goes when the server has several practices and
 * PORTAL_SIGNUP_PRACTICE_ID isn't set: the first practice set up, which on a
 * single-clinic server is the clinic itself.
 */
async function oldestPracticeId(tx: Database): Promise<string | null> {
  const [oldest] = await tx
    .select({ id: practices.id })
    .from(practices)
    .where(isNull(practices.deletedAt))
    .orderBy(asc(practices.createdAt))
    .limit(1);
  if (oldest) {
    console.warn("[portal-sso] PORTAL_SIGNUP_PRACTICE_ID is not set; new account joins the first practice");
  }
  return oldest?.id ?? null;
}
