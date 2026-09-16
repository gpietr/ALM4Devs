import { type TenantTx, schema } from "@galm/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { DomainError } from "./errors";

/** User-definable test environments (e.g. "Staging", "Device Simulator", "Production-
 * like") - same pattern as test-levels.ts, seeded with a single "Default" row. */
export const DEFAULT_TEST_ENVIRONMENTS: ReadonlyArray<{ name: string; sortOrder: number }> = [
  { name: "Default", sortOrder: 0 },
];

export async function seedDefaultEnvironments(db: TenantTx, tenantId: string) {
  return db
    .insert(schema.testEnvironments)
    .values(DEFAULT_TEST_ENVIRONMENTS.map((e) => ({ tenantId, ...e })))
    .returning();
}

export async function listEnvironments(db: TenantTx, tenantId: string) {
  return db
    .select()
    .from(schema.testEnvironments)
    .where(eq(schema.testEnvironments.tenantId, tenantId))
    .orderBy(asc(schema.testEnvironments.sortOrder));
}

export async function getEnvironment(db: TenantTx, tenantId: string, environmentId: string) {
  const [env] = await db
    .select()
    .from(schema.testEnvironments)
    .where(and(eq(schema.testEnvironments.id, environmentId), eq(schema.testEnvironments.tenantId, tenantId)));
  if (!env) throw new DomainError(`environment ${environmentId} not found`);
  return env;
}

export async function createEnvironment(db: TenantTx, tenantId: string, name: string) {
  const existing = await listEnvironments(db, tenantId);
  const nextSortOrder = existing.length > 0 ? Math.max(...existing.map((e) => e.sortOrder)) + 1 : 0;
  const [env] = await db
    .insert(schema.testEnvironments)
    .values({ tenantId, name, sortOrder: nextSortOrder })
    .returning();
  if (!env) throw new DomainError("failed to create environment");
  return env;
}

export async function renameEnvironment(db: TenantTx, tenantId: string, environmentId: string, name: string) {
  await getEnvironment(db, tenantId, environmentId);
  const [updated] = await db
    .update(schema.testEnvironments)
    .set({ name })
    .where(and(eq(schema.testEnvironments.id, environmentId), eq(schema.testEnvironments.tenantId, tenantId)))
    .returning();
  if (!updated) throw new DomainError("rename failed");
  return updated;
}

export async function reorderEnvironment(
  db: TenantTx,
  tenantId: string,
  environmentId: string,
  direction: "up" | "down",
) {
  const all = await listEnvironments(db, tenantId);
  const index = all.findIndex((e) => e.id === environmentId);
  if (index === -1) throw new DomainError(`environment ${environmentId} not found`);
  const swapIndex = direction === "up" ? index - 1 : index + 1;
  if (swapIndex < 0 || swapIndex >= all.length) return all;
  const current = all[index]!;
  const other = all[swapIndex]!;
  await db
    .update(schema.testEnvironments)
    .set({ sortOrder: other.sortOrder })
    .where(eq(schema.testEnvironments.id, current.id));
  await db
    .update(schema.testEnvironments)
    .set({ sortOrder: current.sortOrder })
    .where(eq(schema.testEnvironments.id, other.id));
  return listEnvironments(db, tenantId);
}

export async function deleteEnvironment(db: TenantTx, tenantId: string, environmentId: string) {
  const all = await listEnvironments(db, tenantId);
  if (all.length <= 1) {
    throw new DomainError("cannot delete the only remaining environment - at least one is required");
  }
  await getEnvironment(db, tenantId, environmentId);

  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.testExecutions)
    .where(and(eq(schema.testExecutions.environmentId, environmentId), eq(schema.testExecutions.tenantId, tenantId)));
  const count = row?.count ?? 0;
  if (count > 0) {
    throw new DomainError(
      `cannot delete an environment that has test executions using it (${count} execution${count === 1 ? "" : "s"})`,
    );
  }

  await db
    .delete(schema.testEnvironments)
    .where(and(eq(schema.testEnvironments.id, environmentId), eq(schema.testEnvironments.tenantId, tenantId)));
}
