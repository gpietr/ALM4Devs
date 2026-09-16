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
 * User-definable test-case levels - same reasoning and shape as requirement levels (see
 * requirement-levels.ts's comment), except seeded with a single "Default" row rather than
 * three, matching how most teams start before they need more than one test-organization
 * scheme.
 *
 * A thin kind="test" wrapper over levels.ts's shared implementation - see
 * packages/db/src/schema.ts's `levels` table docstring for why requirement levels and
 * test levels are one physical table, not two. Kept as its own module (rather than
 * inlining `kind: "test"` at every call site) so routers and the tenant-defaults backfill
 * script are unaffected by the merge.
 */
export const DEFAULT_TEST_LEVELS: ReadonlyArray<{ name: string; code: string; sortOrder: number }> = [
  { name: "Default", code: "TC", sortOrder: 0 },
];

export function seedDefaultTestLevels(db: TenantTx, tenantId: string) {
  return seedLevels(db, tenantId, "test", DEFAULT_TEST_LEVELS);
}

export function listTestLevels(db: TenantTx, tenantId: string) {
  return listLevelsOfKind(db, tenantId, "test");
}

export function getTestLevel(db: TenantTx, tenantId: string, levelId: string) {
  return getLevelOfKind(db, tenantId, "test", levelId);
}

export function createTestLevel(db: TenantTx, tenantId: string, name: string, code: string) {
  return createLevelOfKind(db, tenantId, "test", name, code);
}

export function renameTestLevel(db: TenantTx, tenantId: string, levelId: string, name: string) {
  return renameLevelOfKind(db, tenantId, "test", levelId, name);
}

/** See levels.ts's updateLevelCodeOfKind - a separate mutation from renameTestLevel, and
 * refused once any test case already uses this level. */
export function updateTestLevelCode(db: TenantTx, tenantId: string, levelId: string, code: string) {
  return updateLevelCodeOfKind(db, tenantId, "test", levelId, code);
}

export function reorderTestLevel(db: TenantTx, tenantId: string, levelId: string, direction: "up" | "down") {
  return reorderLevelOfKind(db, tenantId, "test", levelId, direction);
}

export function deleteTestLevel(db: TenantTx, tenantId: string, levelId: string) {
  return deleteLevelOfKind(db, tenantId, "test", levelId);
}
