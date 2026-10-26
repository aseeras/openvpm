import { and, eq, isNull } from "drizzle-orm";
import { portalSignInIdentities } from "@openpims/db";
import { createRouter, portalProcedure, publicProcedure } from "../trpc";
import { appleSignInEnabled } from "@/lib/portal/apple-sign-in";

/**
 * Sign-in options for the client app. Linking itself goes through
 * /api/portal/apple, which needs the one-time nonce cookie.
 */
export const portalSignInRouter = createRouter({
  /** Whether the server accepts Sign in with Apple at all (no session needed). */
  options: publicProcedure.query(() => ({ apple: appleSignInEnabled() })),

  /** Whether this client has an Apple ID connected. */
  status: portalProcedure.query(async ({ ctx }) => {
    const [link] = await ctx.db
      .select({ id: portalSignInIdentities.id })
      .from(portalSignInIdentities)
      .where(
        and(
          eq(portalSignInIdentities.practiceId, ctx.portalClient.practiceId),
          eq(portalSignInIdentities.clientId, ctx.portalClient.id),
          eq(portalSignInIdentities.provider, "apple"),
          isNull(portalSignInIdentities.deletedAt),
        ),
      )
      .limit(1);
    return { appleAvailable: appleSignInEnabled(), appleLinked: Boolean(link) };
  }),

  /** Disconnect Sign in with Apple from this client. */
  unlinkApple: portalProcedure.mutation(async ({ ctx }) => {
    await ctx.db
      .update(portalSignInIdentities)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(portalSignInIdentities.practiceId, ctx.portalClient.practiceId),
          eq(portalSignInIdentities.clientId, ctx.portalClient.id),
          eq(portalSignInIdentities.provider, "apple"),
          isNull(portalSignInIdentities.deletedAt),
        ),
      );
    return { appleLinked: false };
  }),
});
