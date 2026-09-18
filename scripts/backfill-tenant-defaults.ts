import {
  seedDefaultArchitectureLevels,
  seedDefaultEnvironments,
  seedDefaultLevels,
  seedDefaultStatuses,
  seedDefaultTenantSettings,
  seedDefaultTestLevels,
} from "@galm/core";
import { createAdminDb, createAppDb, schema, withTenant } from "@galm/db";
import { and, eq, sql } from "drizzle-orm";

/**
 * Idempotent maintenance script: seeds any per-tenant row a tenant should have from
 * sign-up but might be missing (default requirement_statuses, requirement_levels,
 * tenant_settings, test_levels, test_environments). Exists because of a real incident: a
 * tenant created before the domain-model migration shipped had zero requirement_statuses
 * rows, since seeding only happened in /api/register's code path - a schema/behavior
 * change that introduces a new per-tenant invariant needs a data backfill for existing
 * rows, not just a new-signup code path. Every per-tenant default added since gets the
 * same treatment here pre-emptively rather than waiting to be rediscovered the same way.
 * Safe to re-run - every check is count-based, so a tenant that already has the row is
 * left alone.
 *
 * Deliberately uses the migration-owner connection for the diagnostic queries: finding
 * tenants missing a row is a genuinely cross-tenant read, which app_runtime can't do under
 * RLS without a tenant context set - that's the whole point of RLS, not a gap here. The
 * actual seeding writes still go through app_runtime + withTenant, matching how the app
 * writes this data normally.
 *
 * (Each check below is the same shape repeated five times - a candidate for a shared
 * generic helper, not worth fighting Drizzle's per-table generic types for in a
 * maintenance script that isn't on any user-facing path.)
 *
 * Usage: DATABASE_MIGRATION_URL=... DATABASE_URL=... bun run scripts/backfill-tenant-defaults.ts
 */
async function main() {
  const adminDb = createAdminDb();
  const appDb = createAppDb();
  let anyFixed = false;

  const tenantsMissingStatuses = await adminDb
    .select({ id: schema.tenants.id, name: schema.tenants.name })
    .from(schema.tenants)
    .leftJoin(schema.requirementStatuses, eq(schema.requirementStatuses.tenantId, schema.tenants.id))
    .groupBy(schema.tenants.id, schema.tenants.name)
    .having(sql`count(${schema.requirementStatuses.id}) = 0`);
  for (const tenant of tenantsMissingStatuses) {
    await withTenant(appDb, tenant.id, (tx) => seedDefaultStatuses(tx, tenant.id));
    console.log(`Seeded default statuses for tenant "${tenant.name}" (${tenant.id})`);
    anyFixed = true;
  }

  const tenantsMissingLevels = await adminDb
    .select({ id: schema.tenants.id, name: schema.tenants.name })
    .from(schema.tenants)
    .leftJoin(
      schema.levels,
      and(eq(schema.levels.tenantId, schema.tenants.id), eq(schema.levels.kind, "requirement")),
    )
    .groupBy(schema.tenants.id, schema.tenants.name)
    .having(sql`count(${schema.levels.id}) = 0`);
  for (const tenant of tenantsMissingLevels) {
    await withTenant(appDb, tenant.id, (tx) => seedDefaultLevels(tx, tenant.id));
    console.log(`Seeded default levels for tenant "${tenant.name}" (${tenant.id})`);
    anyFixed = true;
  }

  const tenantsMissingSettings = await adminDb
    .select({ id: schema.tenants.id, name: schema.tenants.name })
    .from(schema.tenants)
    .leftJoin(schema.tenantSettings, eq(schema.tenantSettings.tenantId, schema.tenants.id))
    .where(sql`${schema.tenantSettings.tenantId} is null`);
  for (const tenant of tenantsMissingSettings) {
    await withTenant(appDb, tenant.id, (tx) => seedDefaultTenantSettings(tx, tenant.id));
    console.log(`Seeded default settings for tenant "${tenant.name}" (${tenant.id})`);
    anyFixed = true;
  }

  const tenantsMissingTestLevels = await adminDb
    .select({ id: schema.tenants.id, name: schema.tenants.name })
    .from(schema.tenants)
    .leftJoin(schema.levels, and(eq(schema.levels.tenantId, schema.tenants.id), eq(schema.levels.kind, "test")))
    .groupBy(schema.tenants.id, schema.tenants.name)
    .having(sql`count(${schema.levels.id}) = 0`);
  for (const tenant of tenantsMissingTestLevels) {
    await withTenant(appDb, tenant.id, (tx) => seedDefaultTestLevels(tx, tenant.id));
    console.log(`Seeded default test levels for tenant "${tenant.name}" (${tenant.id})`);
    anyFixed = true;
  }

  const tenantsMissingArchitectureLevels = await adminDb
    .select({ id: schema.tenants.id, name: schema.tenants.name })
    .from(schema.tenants)
    .leftJoin(
      schema.levels,
      and(eq(schema.levels.tenantId, schema.tenants.id), eq(schema.levels.kind, "architecture")),
    )
    .groupBy(schema.tenants.id, schema.tenants.name)
    .having(sql`count(${schema.levels.id}) = 0`);
  for (const tenant of tenantsMissingArchitectureLevels) {
    await withTenant(appDb, tenant.id, (tx) => seedDefaultArchitectureLevels(tx, tenant.id));
    console.log(`Seeded default architecture levels for tenant "${tenant.name}" (${tenant.id})`);
    anyFixed = true;
  }

  const tenantsMissingEnvironments = await adminDb
    .select({ id: schema.tenants.id, name: schema.tenants.name })
    .from(schema.tenants)
    .leftJoin(schema.testEnvironments, eq(schema.testEnvironments.tenantId, schema.tenants.id))
    .groupBy(schema.tenants.id, schema.tenants.name)
    .having(sql`count(${schema.testEnvironments.id}) = 0`);
  for (const tenant of tenantsMissingEnvironments) {
    await withTenant(appDb, tenant.id, (tx) => seedDefaultEnvironments(tx, tenant.id));
    console.log(`Seeded default environments for tenant "${tenant.name}" (${tenant.id})`);
    anyFixed = true;
  }

  if (!anyFixed) {
    console.log("No tenants missing any default rows.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
