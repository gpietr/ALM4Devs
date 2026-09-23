import { db } from "@/lib/db";
import { schema } from "@galm/db";
import { enqueue } from "@galm/jobs";
import { betterAuth } from "better-auth";
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
    },
  },
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
});
