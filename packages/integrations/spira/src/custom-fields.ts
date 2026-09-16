import {
  type CustomFieldEntityType,
  type CustomFieldType,
  type CustomFieldValueInput,
  getOrCreateCustomFieldListOption,
  listCustomFieldDefinitions,
  listCustomFieldListOptions,
} from "@galm/core";
import { type AppDb, type TenantTx, withTenant } from "@galm/db";
import { readSpiraField, type SpiraArtifact } from "./client";

/**
 * Bridges a tenant's custom-field mapping (our field id -> Spira field key, see
 * RequirementFieldMapping.customFields/TestCaseFieldMapping.customFields) to the shape
 * packages/core's setCustomFieldValues expects. Split from import.ts/test-case-import.ts
 * since both need the identical logic.
 */

export interface CustomFieldMappingResolution {
  fieldId: string;
  /** Our field's own name, only used to identify it by name in a human-readable
   * unmatched-value note (see resolveCustomFieldValues) - not written anywhere. */
  fieldName: string;
  spiraKey: string;
  fieldType: CustomFieldType;
  /** field_type='list' only: normalized (trimmed, lowercased) option text -> that
   * option's id, since a value is stored as the option's id (see
   * packages/db/src/schema.ts's customFieldValues docstring), not its raw text. Empty
   * for every other field type. */
  optionIdByNormalizedText: Map<string, string>;
}

/** Loads the resolution once per import run (not per row) - a short read-only
 * transaction, separate from the per-row write transactions the caller opens for the
 * actual import. A mapped field id that no longer exists (deleted/renamed away since the
 * operator picked it in the mapping UI) is silently skipped rather than failing the
 * whole run - the same leniency this importer already applies everywhere else. */
export async function loadCustomFieldMappingResolution(
  db: AppDb,
  tenantId: string,
  entityType: CustomFieldEntityType,
  customFields: Record<string, string> | undefined,
): Promise<CustomFieldMappingResolution[]> {
  if (!customFields || Object.keys(customFields).length === 0) return [];
  return withTenant(db, tenantId, async (tx) => {
    const definitions = await listCustomFieldDefinitions(tx, tenantId, entityType);
    const definitionById = new Map(definitions.map((d) => [d.id, d]));

    const resolution: CustomFieldMappingResolution[] = [];
    for (const [fieldId, spiraKey] of Object.entries(customFields)) {
      const field = definitionById.get(fieldId);
      if (!field) continue;
      const fieldType = field.fieldType as CustomFieldType;
      let optionIdByNormalizedText = new Map<string, string>();
      if (fieldType === "list") {
        const options = await listCustomFieldListOptions(tx, tenantId, fieldId);
        optionIdByNormalizedText = new Map(options.map((o) => [o.value.trim().toLowerCase(), o.id]));
      }
      resolution.push({ fieldId, fieldName: field.name, spiraKey, fieldType, optionIdByNormalizedText });
    }
    return resolution;
  });
}

/** A mapped list field whose Spira value didn't match any of that field's own options -
 * see resolveCustomFieldValues. Not an error, and no longer even means "left unset": a
 * real user hit exactly this as a second-order "nothing updated" surprise after 9.21/9.22
 * were fixed (with no list options defined yet, every row's list value silently resolved
 * to null forever, and a row whose only mapped change was that field then correctly
 * reported "unchanged" - which reads exactly like a bug even though nothing was actually
 * broken), and asked for the obvious fix: auto-create the missing option instead of
 * requiring it to exist beforehand. `autoCreateMissingListOptions` below does that; this
 * type is what it (and its caller's `note`-building) works from - see backlog item 9.25. */
export interface UnmatchedListValue {
  fieldId: string;
  fieldName: string;
  rawValue: string;
}

export interface ResolvedCustomFieldValues {
  values: CustomFieldValueInput[];
  unmatchedListValues: UnmatchedListValue[];
}

/** Reads and resolves every mapped custom field's value off one raw Spira artifact - the
 * per-row step, using the resolution loadCustomFieldMappingResolution computed once for
 * the whole run. A list value with no matching option (a stale/renamed Spira-side value,
 * or the field simply has no options defined yet) resolves to null - "unset", not an
 * error; setCustomFieldValues still enforces required-ness on the actual write - but is
 * also reported back via `unmatchedListValues` so the caller can put it in the row's
 * note instead of it staying invisible. */
export function resolveCustomFieldValues(
  artifact: SpiraArtifact,
  resolution: CustomFieldMappingResolution[],
): ResolvedCustomFieldValues {
  const values: CustomFieldValueInput[] = [];
  const unmatchedListValues: UnmatchedListValue[] = [];
  for (const { fieldId, fieldName, spiraKey, fieldType, optionIdByNormalizedText } of resolution) {
    const raw = readSpiraField(artifact, spiraKey);
    if (fieldType === "list") {
      const optionId = raw ? optionIdByNormalizedText.get(raw.trim().toLowerCase()) : undefined;
      if (raw && !optionId) unmatchedListValues.push({ fieldId, fieldName, rawValue: raw });
      values.push({ fieldId, value: optionId ?? null });
    } else {
      values.push({ fieldId, value: raw });
    }
  }
  return { values, unmatchedListValues };
}

export interface AutoCreatedListOption {
  fieldName: string;
  value: string;
}

/** Creates the missing option for every `unmatchedListValues` entry (using Spira's own
 * value text, case preserved) and swaps its new id into `customFieldValues` in place of
 * the `null` resolveCustomFieldValues left there - so the very row that first saw an
 * unmapped value is the one that ends up storing it, not just some future re-import after
 * a human manually adds the option. Must run inside the same per-row write transaction as
 * the row's own create/update (needs a real DB write), which is why this is a separate
 * step from resolveCustomFieldValues rather than folded into it - that function stays a
 * pure, transaction-free read so preview can keep calling it too.
 *
 * Mutates `resolution`'s per-field `optionIdByNormalizedText` map in place as it creates
 * each option, so a value created for one row is immediately reused - not recreated - by
 * every later row in the *same* run with the same value (resolveCustomFieldValues reads
 * that same shared map for every row). */
export async function autoCreateMissingListOptions(
  tx: TenantTx,
  tenantId: string,
  customFieldValues: CustomFieldValueInput[],
  unmatchedListValues: UnmatchedListValue[],
  resolution: CustomFieldMappingResolution[],
): Promise<{ customFieldValues: CustomFieldValueInput[]; created: AutoCreatedListOption[] }> {
  if (unmatchedListValues.length === 0) return { customFieldValues, created: [] };

  const updated = [...customFieldValues];
  const created: AutoCreatedListOption[] = [];
  for (const { fieldId, fieldName, rawValue } of unmatchedListValues) {
    const { id, created: wasCreated } = await getOrCreateCustomFieldListOption(tx, tenantId, fieldId, rawValue);
    const entry = resolution.find((r) => r.fieldId === fieldId);
    entry?.optionIdByNormalizedText.set(rawValue.trim().toLowerCase(), id);
    if (wasCreated) created.push({ fieldName, value: rawValue.trim() });
    const idx = updated.findIndex((v) => v.fieldId === fieldId);
    if (idx >= 0) updated[idx] = { fieldId, value: id };
  }
  return { customFieldValues: updated, created };
}

/** Renders `autoCreateMissingListOptions`'s `created` list as one short, human-readable
 * note fragment, or `undefined` when nothing was created (the common case once a field's
 * options have stabilized) - so callers can fold it straight into an
 * ImportRowResult/TestCaseImportRowResult's `note` alongside whatever else is already
 * there. */
export function formatAutoCreatedOptionsNote(created: AutoCreatedListOption[]): string | undefined {
  if (created.length === 0) return undefined;
  return created.map((c) => `created new option "${c.value}" for "${c.fieldName}"`).join("; ");
}
