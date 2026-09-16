import { createAdminDb, createAppDb, schema, withTenant } from "@galm/db";
import { eq } from "drizzle-orm";

/**
 * Walking-skeleton seed + RLS proof (BACKLOG.md item 0, checklist #2).
 * Run with: bun run db:seed
 */
async function main() {
  const admin = createAdminDb();

  const [tenantA] = await admin.insert(schema.tenants).values({ name: "Tenant A" }).returning();
  const [tenantB] = await admin.insert(schema.tenants).values({ name: "Tenant B" }).returning();
  if (!tenantA || !tenantB) throw new Error("failed to insert tenants");

  await admin.insert(schema.items).values([
    { tenantId: tenantA.id, label: "A-item-1" },
    { tenantId: tenantB.id, label: "B-item-1" },
  ]);
  console.log(`Seeded tenant A (${tenantA.id}) and tenant B (${tenantB.id}), one item each.`);

  const app = createAppDb();

  // Connected as app_runtime, tenant context set to A: querying for B's item IDs must
  // return nothing if RLS is actually binding, not just declared.
  const leaked = await withTenant(app, tenantA.id, (tx) =>
    tx.select().from(schema.items).where(eq(schema.items.tenantId, tenantB.id)),
  );

  if (leaked.length !== 0) {
    console.error(
      `RLS FAILED: connected as tenant A but read ${leaked.length} row(s) belonging to tenant B.`,
    );
    process.exit(1);
  }

  // Sanity check the positive case too: tenant A must still see its own row.
  const ownRows = await withTenant(app, tenantA.id, (tx) =>
    tx.select().from(schema.items).where(eq(schema.items.tenantId, tenantA.id)),
  );
  if (ownRows.length !== 1) {
    console.error(`RLS misconfigured: expected 1 own row for tenant A, got ${ownRows.length}.`);
    process.exit(1);
  }

  console.log("RLS OK: tenant A reads its own item and cannot read tenant B's.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
