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
 * User-definable architecture levels (System Architecture / Software Architecture by
 * default). Unlike requirement levels, sortOrder is display order only - each
 * (product, architecture-level) is an independent tree, so a tenant can add a level per
 * software in a multi-software product without those trees parenting each other. See
 * packages/core/src/architecture.ts for the containment rules inside a single level.
 *
 * A thin kind="architecture" wrapper over levels.ts's shared implementation - same
 * reasoning as requirement-levels.ts / test-levels.ts.
 */
export const DEFAULT_ARCHITECTURE_LEVELS: ReadonlyArray<{ name: string; code: string; sortOrder: number }> = [
  { name: "System Architecture", code: "SYSARCH", sortOrder: 0 },
  { name: "Software Architecture", code: "SWARCH", sortOrder: 1 },
];

export function seedDefaultArchitectureLevels(db: TenantTx, tenantId: string) {
  return seedLevels(db, tenantId, "architecture", DEFAULT_ARCHITECTURE_LEVELS);
}

/** Same guarantee test-case "Default" has: a product is usable for architecture without
 * a trip to Settings. Tenants created before architecture existed (or whose levels were
 * wiped) have none - seed SYSARCH/SWARCH then. No-op when the tenant already defined
 * its own. Called from register, product create, and first list. */
export async function ensureDefaultArchitectureLevels(db: TenantTx, tenantId: string) {
  const existing = await listLevelsOfKind(db, tenantId, "architecture");
  if (existing.length > 0) return existing;
  // seedDefaultArchitectureLevels no longer throws on a concurrent-seed race (see
  // seedLevels's onConflictDoNothing) - it just returns fewer rows than requested, so the
  // list below always reflects whichever request's insert actually landed.
  await seedDefaultArchitectureLevels(db, tenantId);
  return listLevelsOfKind(db, tenantId, "architecture");
}

export function listArchitectureLevels(db: TenantTx, tenantId: string) {
  return ensureDefaultArchitectureLevels(db, tenantId);
}

export function getArchitectureLevel(db: TenantTx, tenantId: string, levelId: string) {
  return getLevelOfKind(db, tenantId, "architecture", levelId);
}

export function createArchitectureLevel(db: TenantTx, tenantId: string, name: string, code: string) {
  return createLevelOfKind(db, tenantId, "architecture", name, code);
}

export function renameArchitectureLevel(db: TenantTx, tenantId: string, levelId: string, name: string) {
  return renameLevelOfKind(db, tenantId, "architecture", levelId, name);
}

/** See levels.ts's updateLevelCodeOfKind - a separate mutation from renameArchitectureLevel,
 * and refused once any architecture node already uses this level. */
export function updateArchitectureLevelCode(db: TenantTx, tenantId: string, levelId: string, code: string) {
  return updateLevelCodeOfKind(db, tenantId, "architecture", levelId, code);
}

export function reorderArchitectureLevel(db: TenantTx, tenantId: string, levelId: string, direction: "up" | "down") {
  return reorderLevelOfKind(db, tenantId, "architecture", levelId, direction);
}

export function deleteArchitectureLevel(db: TenantTx, tenantId: string, levelId: string) {
  return deleteLevelOfKind(db, tenantId, "architecture", levelId);
}
