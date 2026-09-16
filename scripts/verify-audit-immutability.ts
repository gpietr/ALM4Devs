import { createAdminDb, createAppDb, schema, withTenant } from "@galm/db";
import { eq } from "drizzle-orm";

/**
 * Walking-skeleton audit-log immutability proof (BACKLOG.md item 0, checklist #5).
 * Run with: bun run verify:audit-immutability
 *
 * Inserts a row as app_runtime (the only credential the running app ever uses), then
 * attempts an UPDATE through that same credential and confirms it is rejected - both by
 * the REVOKE (the grant simply isn't there) and, if the grant were ever mistakenly
 * restored, by the trigger underneath it.
 */
async function main() {
  const admin = createAdminDb();
  const [tenant] = await admin
    .insert(schema.tenants)
    .values({ name: "Audit Immutability Test Tenant" })
    .returning();
  if (!tenant) throw new Error("failed to insert tenant");

  const app = createAppDb();

  const [row] = await withTenant(app, tenant.id, (tx) =>
    tx
      .insert(schema.auditLog)
      .values({
        tenantId: tenant.id,
        action: "test.insert",
        entityType: "test",
        entityId: "1",
        payload: { note: "walking skeleton check" },
      })
      .returning(),
  );
  if (!row) throw new Error("failed to insert audit_log row");
  console.log(`Inserted audit_log row ${row.id}`);
  console.log(`  prev_hash: ${row.prevHash ?? "(none - first row in chain)"}`);
  console.log(`  row_hash:  ${row.rowHash}`);

  let updateRejected = false;
  try {
    await withTenant(app, tenant.id, (tx) =>
      tx
        .update(schema.auditLog)
        .set({ action: "test.tampered" })
        .where(eq(schema.auditLog.id, row.id)),
    );
  } catch (err) {
    updateRejected = true;
    console.log("UPDATE correctly rejected:", err instanceof Error ? err.message : err);
  }

  if (!updateRejected) {
    console.error("IMMUTABILITY FAILED: audit_log UPDATE was not rejected.");
    process.exit(1);
  }

  console.log("Audit log immutability OK: UPDATE rejected as designed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
