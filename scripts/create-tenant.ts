import { createAdminDb, schema } from "@galm/db";

/**
 * Small helper for the verify-walking-skeleton.sh script: creates one tenant and prints
 * just its id (nothing else) so a shell script can capture it with $(...).
 * Usage: bun run scripts/create-tenant.ts "Some Tenant Name"
 */
async function main() {
  const name = process.argv[2] ?? "Verification Tenant";
  const admin = createAdminDb();
  const [tenant] = await admin.insert(schema.tenants).values({ name }).returning();
  if (!tenant) throw new Error("failed to insert tenant");
  process.stdout.write(tenant.id);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
