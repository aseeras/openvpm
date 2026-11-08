"use client";

import { trpc } from "@/lib/trpc";

/**
 * Whether this browser has a live client portal session: `true`, `false`, or
 * `undefined` while it is being checked. Signed-in-only portal queries wait
 * for `true`, so guests don't trigger 401 responses.
 */
export function usePortalSignedIn(enabled = true): boolean | undefined {
  const session = trpc.portalSignIn.session.useQuery(undefined, {
    enabled,
    retry: false,
    staleTime: 60 * 1000,
  });
  return session.data?.signedIn;
}
