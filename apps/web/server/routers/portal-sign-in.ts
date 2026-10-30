import { and, eq, isNull } from "drizzle-orm";
import { portalSignInIdentities } from "@openpims/db";
import { createRouter, portalProcedure, publicProcedure } from "../trpc";
import { appleSignInEnabled } from "@/lib/portal/apple-sign-in";
import { webSignInOptions } from "@/lib/portal/web-sso";

/**
 * Sign-in options for the client app. Linking itself goes through
 * /api/portal/apple, which needs the one-time nonce cookie.
 */
export const portalSignInRouter = createRouter({
  /**
   * Which sign-in providers the server accepts (no session needed): `apple`
   * for the iPhone app's native sheet, `web` for the browser redirect flow.
   */
  options: publicProcedure.query(() => ({ apple: appleSignInEnabled(), web: webSignInOptions() })),

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
