import { db } from "@/lib/db";
import { schema } from "@galm/db";
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
