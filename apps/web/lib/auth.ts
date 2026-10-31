import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { compare } from "bcryptjs";
import { z } from "zod";
import { db } from "@openpims/db/client";
import { practices, users } from "@openpims/db";
import { and, eq, isNull } from "drizzle-orm";
import { withSystem } from "@/lib/tenant-db";
import { clearRateLimit, rateLimit } from "@/lib/rate-limit";
import { clientIpFromRequest } from "@/lib/request-ip";
import { AUTH_PASSWORD_MAX_LENGTH } from "@/lib/auth-password";
import { AUTH_EMAIL_MAX_LENGTH } from "@/lib/auth-input-policy";
import { nextAuthSecret } from "@/lib/auth-secret";
import {
  DEMO_ROLE_EMAILS,
  demoModeEnabled,
  isDemoRole,
  verifiedDemoAccessFromRequest,
} from "@/lib/demo-access";
import {
  APPLE_IDENTITY_TOKEN_MAX_LENGTH,
  AppleTokenError,
  verifyAppleIdentityToken,
} from "@/lib/portal/apple-sign-in";
import {
  cookieFromHeader,
  findStaffForAppleIdentity,
  STAFF_APPLE_NONCE_COOKIE,
  staffAppleClientIds,
} from "@/lib/staff-apple-sign-in";

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_EMAIL_LIMIT = 8;
const LOGIN_IP_LIMIT = 40;
export const LOGIN_EMAIL_MAX_LENGTH = AUTH_EMAIL_MAX_LENGTH;
const DUMMY_PASSWORD_HASH =
  "$2a$12$952CXRCtzm0M4qmcFoZkteQvA5Tdh.CIhvCabrgb5qUbk.VcE35va";
const DEMO_PRACTICE_NAME = "Neighborhood Veterinary";
const APPLE_IP_LIMIT = 20;

/** Messages the sign-in page shows when Sign in with Apple can't open a login. */
export const STAFF_APPLE_ERRORS = {
  notConnected: "apple_not_connected",
  expired: "apple_expired",
  failed: "apple_failed",
  busy: "apple_busy",
} as const;

function headerValue(
  headers: Record<string, unknown> | undefined,
  name: string,
): string | null {
  const value = headers?.[name];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
}

const loginCredentialsInput = z.object({
  email: z
    .string()
    .trim()
    .email()
    .max(LOGIN_EMAIL_MAX_LENGTH)
    .transform((value) => value.toLowerCase()),
  password: z.string().min(1).max(AUTH_PASSWORD_MAX_LENGTH),
});

export function parseLoginCredentials(
  credentials: Record<"email" | "password", string> | undefined
): { email: string; password: string } | null {
  const parsed = loginCredentialsInput.safeParse(credentials);
  return parsed.success ? parsed.data : null;
}

export const clientIpFromAuthRequest = clientIpFromRequest;

export function loginRateLimitKeys(email: string, ip: string): {
  emailKey: string;
  ipKey: string;
} {
  return {
    emailKey: `login:email:${email.trim().toLowerCase()}`,
    ipKey: `login:ip:${ip || "unknown"}`,
  };
}

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      email: string;
      name: string;
      role: "admin" | "veterinarian" | "technician" | "front_desk" | "viewer";
      practiceId: string;
      emailVerifiedAt?: Date | string | null;
      practiceCreatedAt?: Date | string | null;
    };
  }
  interface User {
    id: string;
    email: string;
    name: string;
    role: "admin" | "veterinarian" | "technician" | "front_desk" | "viewer";
    practiceId: string;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: string;
    role: "admin" | "veterinarian" | "technician" | "front_desk" | "viewer";
    practiceId: string;
  }
}

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials, req) {
        // The hosted demo uses its own signed email gate. Never leave the
        // seeded password accounts as a bypass on that deployment.
        if (demoModeEnabled()) return null;

        const parsedCredentials = parseLoginCredentials(credentials);
        if (!parsedCredentials) {
          return null;
        }
        const { email, password } = parsedCredentials;
        const ip = clientIpFromAuthRequest(req);
        const { emailKey, ipKey } = loginRateLimitKeys(email, ip);

        let emailLimit: Awaited<ReturnType<typeof rateLimit>>;
        let ipLimit: Awaited<ReturnType<typeof rateLimit>>;
        try {
          [emailLimit, ipLimit] = await Promise.all([
            rateLimit({
              key: emailKey,
              limit: LOGIN_EMAIL_LIMIT,
              windowMs: LOGIN_WINDOW_MS,
            }),
            rateLimit({
              key: ipKey,
              limit: LOGIN_IP_LIMIT,
              windowMs: LOGIN_WINDOW_MS,
            }),
          ]);
        } catch (err) {
          console.error("[auth] login rate limit failed:", err);
          return null;
        }

        if (!emailLimit.success || !ipLimit.success) {
          return null;
        }

        // Login looks up by email with no tenant context yet → system context.
        const [user] = await withSystem(db, (tx) =>
          tx
            .select()
            .from(users)
            .where(and(eq(users.email, email), isNull(users.deletedAt)))
            .limit(1)
        );

        if (!user) {
          await compare(password, DUMMY_PASSWORD_HASH);
          return null;
        }

        const isValid = await compare(password, user.passwordHash);
        if (!isValid) return null;

        await clearRateLimit(emailKey).catch(() => undefined);

        // Email verification is a SOFT requirement on hosted: new users sign in
        // immediately after signup (so the trial + onboarding aren't blocked by
        // an email round-trip) and are nudged to confirm via an in-app banner.
        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          practiceId: user.practiceId,
        };
      },
    }),
    CredentialsProvider({
      id: "demo",
      name: "demo",
      credentials: {
        role: { label: "Role", type: "text" },
      },
      async authorize(credentials, req) {
        if (
          !demoModeEnabled() ||
          !verifiedDemoAccessFromRequest(req) ||
          !isDemoRole(credentials?.role)
        ) {
          return null;
        }

        const demoEmail = DEMO_ROLE_EMAILS[credentials.role];
        const user = await withSystem(db, async (tx) => {
          const [candidate] = await tx
            .select()
            .from(users)
            .where(
              and(eq(users.email, demoEmail), isNull(users.deletedAt))
            )
            .limit(1);
          if (!candidate) return null;

          const [practice] = await tx
            .select({ id: practices.id })
            .from(practices)
            .where(
              and(
                eq(practices.id, candidate.practiceId),
                eq(practices.name, DEMO_PRACTICE_NAME),
                isNull(practices.deletedAt)
              )
            )
            .limit(1);
          return practice ? candidate : null;
        });

        if (!user) return null;
        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          practiceId: user.practiceId,
        };
      },
    }),
    CredentialsProvider({
      // Sign in with Apple from the staff iPhone/iPad app. The app gets an
      // identity token from Apple carrying the nonce this server handed out
      // (kept in an httpOnly cookie); it only opens an existing staff login.
      id: "apple",
      name: "apple",
      credentials: {
        identityToken: { label: "Apple identity token", type: "text" },
      },
      async authorize(credentials, req) {
        if (demoModeEnabled()) return null;
        const audiences = staffAppleClientIds();
        const identityToken = credentials?.identityToken;
        if (
          audiences.length === 0 ||
          typeof identityToken !== "string" ||
          identityToken.length === 0 ||
          identityToken.length > APPLE_IDENTITY_TOKEN_MAX_LENGTH
        ) {
          throw new Error(STAFF_APPLE_ERRORS.failed);
        }

        const ip = clientIpFromAuthRequest(req);
        try {
          const limit = await rateLimit({
            key: `login:apple:ip:${ip || "unknown"}`,
            limit: APPLE_IP_LIMIT,
            windowMs: LOGIN_WINDOW_MS,
          });
          if (!limit.success) throw new Error(STAFF_APPLE_ERRORS.busy);
        } catch (err) {
          if (err instanceof Error && err.message === STAFF_APPLE_ERRORS.busy) throw err;
          console.error("[auth] Apple sign-in rate limit failed");
          throw new Error(STAFF_APPLE_ERRORS.busy);
        }

        const nonce = cookieFromHeader(
          headerValue(req?.headers as Record<string, unknown> | undefined, "cookie"),
          STAFF_APPLE_NONCE_COOKIE,
        );
        if (!nonce) throw new Error(STAFF_APPLE_ERRORS.expired);

        let identity;
        try {
          identity = await verifyAppleIdentityToken(identityToken, { audiences, nonce });
        } catch (err) {
          if (!(err instanceof AppleTokenError)) console.error("[auth] Apple token check failed");
          throw new Error(STAFF_APPLE_ERRORS.failed);
        }

        const user = await withSystem(db, (tx) => findStaffForAppleIdentity(tx, identity));
        if (!user) throw new Error(STAFF_APPLE_ERRORS.notConnected);
        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          practiceId: user.practiceId,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.role = user.role;
        token.practiceId = user.practiceId;
      }
      return token;
    },
    async session({ session, token }) {
      session.user.id = token.id;
      session.user.role = token.role;
      session.user.practiceId = token.practiceId;
      return session;
    },
  },
  pages: {
    signIn: "/login",
  },
  session: {
    strategy: "jwt",
  },
  secret: nextAuthSecret(),
};
