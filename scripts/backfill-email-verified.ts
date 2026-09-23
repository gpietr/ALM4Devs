import { createAppDb, schema } from "@galm/db";
import { eq } from "drizzle-orm";

/**
 * One-time backfill for the email-verification feature: marks every pre-existing user as
 * already verified, so no account created before this shipped is ever blocked from signing
 * in (once REQUIRE_EMAIL_VERIFICATION is turned on) or shown a "verify your email" prompt.
 * New sign-ups from this point on start unverified as normal.
 *
 * Uses the ordinary app_runtime connection, not the migration-owner one: the `user` table
 * isn't RLS-protected (see the note atop apps/web/src/lib/auth.ts), so no tenant context or
 * admin connection is needed here.
 *
 * Safe to re-run - only touches rows where email_verified is still false.
 *
 * Usage: DATABASE_URL=... bun run scripts/backfill-email-verified.ts
 */
async function main() {
  const db = createAppDb();
  const updated = await db
    .update(schema.user)
    .set({ emailVerified: true })
    .where(eq(schema.user.emailVerified, false))
    .returning({ id: schema.user.id });

  if (updated.length === 0) {
    console.log("No unverified users to backfill.");
    return;
  }
  console.log(`Marked ${updated.length} pre-existing user(s) as email-verified.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
