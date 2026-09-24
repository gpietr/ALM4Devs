import { createAppDb, schema } from "@galm/db";
import { eq } from "drizzle-orm";

/**
 * Flips one user's isSystemAdmin flag directly - there is no UI path for this, by design
 * (a highly privileged, cross-tenant flag shouldn't be grantable through any web-facing
 * form). `user` isn't RLS-protected, so the ordinary app_runtime connection is sufficient,
 * unlike scripts/create-tenant.ts's migration-owner connection.
 *
 * Usage: bun run scripts/set-system-admin.ts someone@example.com
 */
async function main() {
  const email = process.argv[2];
  if (!email) {
    throw new Error("usage: bun run scripts/set-system-admin.ts <email>");
  }
  const db = createAppDb();
  const [row] = await db
    .update(schema.user)
    .set({ isSystemAdmin: true })
    .where(eq(schema.user.email, email))
    .returning({ id: schema.user.id });
  if (!row) {
    throw new Error(`no user found with email ${email}`);
  }
  console.log(`${email} is now a system admin.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
