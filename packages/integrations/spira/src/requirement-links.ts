import { listEntityIdsBySource } from "@galm/core";
import { type AppDb, withTenant } from "@galm/db";

/**
 * Resolves Spira's own test-case-to-requirement trace links (backlog item 9.26) against
 * requirements already imported into this system - the test case importer's assumption is
 * that requirements are imported first (a separate screen, see
 * apps/web/src/app/(app)/settings/import/requirements/page.tsx), so this only ever links,
 * never creates, a requirement. Split from custom-fields.ts even though the shape rhymes
 * (a per-run resolution loaded once, then applied per row) because this resolves a whole
 * *entity*, not a field value.
 */

/** Loads every requirement this tenant has already imported from Spira, once per run - the
 * same "resolve once, not per row" idiom as loadCustomFieldMappingResolution - keyed by
 * Spira's own RequirementId (as a string, matching how externalId is always stored) to the
 * local requirement id. */
export async function loadImportedRequirementIdMap(db: AppDb, tenantId: string): Promise<Map<string, string>> {
  return withTenant(db, tenantId, (tx) =>
    listEntityIdsBySource(tx, { tenantId, entityType: "requirement", source: "spira" }),
  );
}

export interface ResolvedRequirementLinks {
  /** Local requirement ids to link this test case to. */
  requirementIds: string[];
  /** Spira's own requirement id, for every linked requirement Spira reports that hasn't
   * been imported here (yet) - surfaced so the operator can import requirements first, or
   * knowingly accept the gap, rather than links silently going missing. */
  unmappedRequirementIds: number[];
}

/** Pure resolver: Spira's own requirement ids for one test case, against the run's shared
 * id map. Split from the (network-bound) fetch of those ids
 * (SpiraClient.listTestCaseRequirementLinks) so this stays trivially testable. */
export function resolveRequirementLinks(
  spiraRequirementIds: number[],
  requirementIdMap: Map<string, string>,
): ResolvedRequirementLinks {
  const requirementIds: string[] = [];
  const unmappedRequirementIds: number[] = [];
  for (const spiraId of spiraRequirementIds) {
    const localId = requirementIdMap.get(String(spiraId));
    if (localId) requirementIds.push(localId);
    else unmappedRequirementIds.push(spiraId);
  }
  return { requirementIds, unmappedRequirementIds };
}
