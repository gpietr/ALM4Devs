import type { TenantTx } from "@galm/db";
import {
  createLevelOfKind,
  deleteLevelOfKind,
  getLevelOfKind,
  listLevelsOfKind,
  renameLevelOfKind,
  reorderLevelOfKind,
  seedLevels,
  updateLevelCodeOfKind,
} from "./levels";

/**
 * User-definable hierarchy levels (User Need / System Requirement / Software Item Spec by
 * default). Unlike requirement_statuses, there's no fixed "category" the code needs
 * special behavior for - sortOrder alone *is* the hierarchy (a requirement's optional
 * parent must be at a strictly lower sortOrder, i.e. higher up/more abstract - see
 * createRequirement in requirements.ts). So level management is plain CRUD: create,
 * rename, reorder, delete - no enable/disable concept the way statuses have.
 *
 * A thin kind="requirement" wrapper over levels.ts's shared implementation - see
 * packages/db/src/schema.ts's `levels` table docstring for why requirement levels and
 * test levels are one physical table, not two. Kept as its own module (rather than
 * inlining `kind: "requirement"` at every call site) so routers, the register route, and
 * the tenant-defaults backfill script are unaffected by the merge.
 */
export const DEFAULT_REQUIREMENT_LEVELS: ReadonlyArray<{ name: string; code: string; sortOrder: number }> = [
  { name: "User Need", code: "USERNEED", sortOrder: 0 },
  { name: "System Requirement", code: "SYSREQ", sortOrder: 1 },
  { name: "Software Item Spec", code: "SWSPEC", sortOrder: 2 },
];

export function seedDefaultLevels(db: TenantTx, tenantId: string) {
  return seedLevels(db, tenantId, "requirement", DEFAULT_REQUIREMENT_LEVELS);
}

export function listLevels(db: TenantTx, tenantId: string) {
  return listLevelsOfKind(db, tenantId, "requirement");
}

export function getLevel(db: TenantTx, tenantId: string, levelId: string) {
  return getLevelOfKind(db, tenantId, "requirement", levelId);
}

export function createLevel(db: TenantTx, tenantId: string, name: string, code: string) {
  return createLevelOfKind(db, tenantId, "requirement", name, code);
}

export function renameLevel(db: TenantTx, tenantId: string, levelId: string, name: string) {
  return renameLevelOfKind(db, tenantId, "requirement", levelId, name);
}

/** See levels.ts's updateLevelCodeOfKind - a separate mutation from renameLevel, and
 * refused once any requirement already uses this level. */
export function updateLevelCode(db: TenantTx, tenantId: string, levelId: string, code: string) {
  return updateLevelCodeOfKind(db, tenantId, "requirement", levelId, code);
}

export function reorderLevel(db: TenantTx, tenantId: string, levelId: string, direction: "up" | "down") {
  return reorderLevelOfKind(db, tenantId, "requirement", levelId, direction);
}

export function deleteLevel(db: TenantTx, tenantId: string, levelId: string) {
  return deleteLevelOfKind(db, tenantId, "requirement", levelId);
}
