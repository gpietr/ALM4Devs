import { type TenantTx, schema } from "@galm/db";
import { and, asc, eq } from "drizzle-orm";
import { assertCategoryCanBeDisabled, type RequirementStatusCategory } from "./requirement-status";
import { DomainError } from "./errors";

/**
 * "Manage states" - the settings-side operations on a tenant's requirement_statuses rows.
 * Kept separate from requirements.ts (which is about requirements moving *through*
 * statuses) since this is about administering the status set itself. Shares the one
 * DomainError from errors.ts rather than each module declaring its own, both to avoid an
 * index.ts re-export collision and because a plain `import from "./requirements"` here
 * would create a cycle (requirements.ts also needs requirement-levels.ts, for the
 * parent-hierarchy check on create).
 */

async function getStatus(db: TenantTx, tenantId: string, statusId: string) {
  const [status] = await db
    .select()
    .from(schema.requirementStatuses)
    .where(and(eq(schema.requirementStatuses.id, statusId), eq(schema.requirementStatuses.tenantId, tenantId)));
  if (!status) throw new DomainError(`status ${statusId} not found`);
  return status;
}

/** Unlike listEnabledStatuses (requirements.ts), includes disabled ones too - the
 * settings screen needs to show and re-enable them. */
export async function listAllStatuses(db: TenantTx, tenantId: string) {
  return db
    .select()
    .from(schema.requirementStatuses)
    .where(eq(schema.requirementStatuses.tenantId, tenantId))
    .orderBy(asc(schema.requirementStatuses.sortOrder));
}

export async function renameStatus(db: TenantTx, tenantId: string, statusId: string, name: string) {
  await getStatus(db, tenantId, statusId);
  const [updated] = await db
    .update(schema.requirementStatuses)
    .set({ name })
    .where(and(eq(schema.requirementStatuses.id, statusId), eq(schema.requirementStatuses.tenantId, tenantId)))
    .returning();
  if (!updated) throw new DomainError("rename failed");
  return updated;
}

export async function setStatusEnabled(db: TenantTx, tenantId: string, statusId: string, enabled: boolean) {
  const status = await getStatus(db, tenantId, statusId);
  if (!enabled) {
    // Throws for 'draft'/'approved' - the minimum viable workflow (not-yet-approved vs.
    // approved) can't be turned off. 'in_review' and 'baselined' can.
    assertCategoryCanBeDisabled(status.category as RequirementStatusCategory);
  }
  const [updated] = await db
    .update(schema.requirementStatuses)
    .set({ isEnabled: enabled })
    .where(and(eq(schema.requirementStatuses.id, statusId), eq(schema.requirementStatuses.tenantId, tenantId)))
    .returning();
  if (!updated) throw new DomainError("update failed");
  return updated;
}

/** Swaps sort_order with the adjacent status (across the whole list, not per-category) -
 * purely a display-order control today; the workflow graph itself is keyed by category,
 * not sort_order, so this can't reorder *behavior*, only how statuses are listed. */
export async function reorderStatus(db: TenantTx, tenantId: string, statusId: string, direction: "up" | "down") {
  const all = await listAllStatuses(db, tenantId);
  const index = all.findIndex((s) => s.id === statusId);
  if (index === -1) throw new DomainError(`status ${statusId} not found`);

  const swapIndex = direction === "up" ? index - 1 : index + 1;
  if (swapIndex < 0 || swapIndex >= all.length) return all;

  const current = all[index]!;
  const other = all[swapIndex]!;
  await db
    .update(schema.requirementStatuses)
    .set({ sortOrder: other.sortOrder })
    .where(eq(schema.requirementStatuses.id, current.id));
  await db
    .update(schema.requirementStatuses)
    .set({ sortOrder: current.sortOrder })
    .where(eq(schema.requirementStatuses.id, other.id));

  return listAllStatuses(db, tenantId);
}
