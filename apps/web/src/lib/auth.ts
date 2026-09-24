import { db } from "@/lib/db";
import { ruleFromEnv } from "@/server/rate-limit";
import { schema } from "@galm/db";
import { enqueue } from "@galm/jobs";
import { APIError, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

// NOTE (learned while wiring this up): better-auth's own queries against user/session/
// account/verification run without our per-request `withTenant` wrapper, because a login
// look-up by email has to happen *before* any tenant is known. Those tables are
// deliberately NOT under RLS - see packages/db/migrations-manual/001_rls_and_audit_immutability.sql.

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
    },
  }),
  emailAndPassword: {
    enabled: true,
    // Instance-wide toggle (TECH_STACK.md section 6): off by default so local dev,
    // self-hosted operators without SMTP configured, and the e2e suite (which assumes
    // /api/register returns an authenticated session immediately) keep working unchanged.
    // Hosted/production deployments set REQUIRE_EMAIL_VERIFICATION=true.
    requireEmailVerification: process.env.REQUIRE_EMAIL_VERIFICATION === "true",
  },
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) => {
      // Queued via pg-boss (packages/jobs) rather than sent inline, so a slow/flaky SMTP
      // relay can't slow down sign-up/sign-in requests, and delivery gets pg-boss's retry
      // behavior for free.
      await enqueue("send-verification-email", { to: user.email, name: user.name, url });
    },
  },
  user: {
    additionalFields: {
      tenantId: {
        type: "string",
        required: true,
        input: true,
      },
      // Org-level role ('admin' | 'member'), settable via signUpEmail's body the same way
      // tenantId is - see /api/register (always "admin") and /api/accept-invite (whatever
      // the invitation offered). See apps/web/src/server/trpc.ts's orgAdminProcedure.
      //
      // input:true here means "settable at *creation* by our two in-process signUpEmail
      // callers" - but better-auth has no way to express that, so it also makes the field
      // writable by any authenticated caller of /update-user. See disabledPaths and
      // databaseHooks.user.update below, which is what actually enforces the intent.
      role: {
        type: "string",
        required: true,
        input: true,
      },
      // Flat, cross-tenant, unrelated to role above. Never settable through sign-up -
      // input:false means signUpEmail silently ignores any caller-supplied value here.
      // Only scripts/set-system-admin.ts ever flips this, directly in the DB. Still
      // declared here so it's readable off session.user for systemAdminProcedure.
      isSystemAdmin: {
        type: "boolean",
        required: false,
        input: false,
      },
      // Same reasoning as isSystemAdmin: never client-settable, but must be readable off
      // session.user for the suspended/removed access gate - see
      // apps/web/src/server/tenant-access.ts.
      removedAt: {
        type: "date",
        required: false,
        input: false,
      },
    },
  },
  // HTTP-only kill list. `auth.api.*` is built straight off getEndpoints, while incoming
  // requests go through better-auth's router - and disabledPaths is only consulted by the
  // router. So /api/register and /api/accept-invite keep working (they call
  // auth.api.signUpEmail in-process), while both public paths 404:
  //
  // - /sign-up/email: tenantId/role are input:true, so an open sign-up endpoint would let
  //   anyone who knows a tenant UUID register themselves into someone else's org as admin.
  // - /update-user: same field-visibility problem, but for an *existing* session. Any
  //   logged-in member could POST {"role":"admin"} to self-promote, or
  //   {"tenantId":"<other org>"} to move their own session into another tenant - which
  //   also moves withTenant's RLS scope, i.e. a total tenant-isolation bypass. Nothing in
  //   this app calls authClient.updateUser, so disabling it costs us nothing.
  disabledPaths: ["/sign-up/email", "/update-user"],
  databaseHooks: {
    user: {
      update: {
        // Belt to disabledPaths' suspenders: no better-auth-initiated update may ever
        // touch the two authorization-bearing fields, however it was reached (a future
        // plugin, a re-enabled /update-user for name/image, a social-profile sync). The
        // app's own writes to these - updateMemberRole/removeMember in
        // packages/core/src/members.ts - go through drizzle directly, not this adapter,
        // so they're unaffected.
        //
        // Throws rather than returning `false`: an aborted update makes better-auth's
        // /update-user fall back to spreading the *requested* fields into the session
        // cookie it then sets. Harmless today (cookieCache is off, so getSession always
        // re-reads the row), but a forged cookie value is not something to leave lying
        // around for whoever turns cookieCache on later.
        before: async (data) => {
          for (const field of ["tenantId", "role", "isSystemAdmin", "removedAt"] as const) {
            if (field in data) {
              throw new APIError("BAD_REQUEST", { message: `${field} is not allowed to be set` });
            }
          }
          return { data };
        },
      },
    },
  },
  // Keyed off a header /api/auth/[...all]/route.ts overwrites with the trusted-proxy-
  // resolved client IP, never the raw (spoofable) X-Forwarded-For.
  advanced: { ipAddress: { ipAddressHeaders: ["x-galm-client-ip"] } },
  rateLimit: {
    customRules: {
      "/sign-in/email": ruleFromEnv("LOGIN", { window: 10, max: 3 }),
    },
  },
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
});
