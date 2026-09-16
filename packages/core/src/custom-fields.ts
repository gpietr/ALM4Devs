import { type TenantTx, schema } from "@galm/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import { DomainError } from "./errors";
import { isUniqueViolation } from "./level-sequences";

/**
 * Tenant-defined custom fields for requirements and test cases (backlog item 9.19) - see
 * packages/db/src/schema.ts's `customFieldDefinitions`/`customFieldListOptions`/
 * `customFieldValues` docstrings for the storage design and why values aren't versioned.
 */

export type CustomFieldEntityType = "requirement" | "test_case";
export type CustomFieldType = "short_text" | "long_text" | "list" | "date" | "integer" | "boolean";

export const CUSTOM_FIELD_TYPES: ReadonlyArray<{ value: CustomFieldType; label: string }> = [
  { value: "short_text", label: "Short text" },
  { value: "long_text", label: "Long text" },
  { value: "list", label: "List (single choice)" },
  { value: "date", label: "Date" },
  { value: "integer", label: "Integer" },
  { value: "boolean", label: "Yes/No" },
];

function noun(entityType: CustomFieldEntityType): string {
  return entityType === "requirement" ? "requirement" : "test case";
}

// --- Default fields, seeded per tenant --------------------------------------------

/** Safety Classification (requirements) and Test Type (test cases) used to be dedicated,
 * hardcoded columns - they're ordinary custom fields now, seeded here so every tenant
 * still gets them without configuring anything, but with zero special treatment beyond
 * that: a tenant can rename, reorder, add options to, or delete them exactly like any
 * other custom field. Seeded once for a brand-new tenant (see seedDefaultCustomFields,
 * called from /api/register) and once, historically, for every pre-existing tenant (see
 * packages/db/migrations-manual/013) - deliberately NOT part of
 * scripts/backfill-tenant-defaults.ts's ongoing "missing a default row" reconciliation,
 * since unlike a level or status, a custom field can be deleted down to zero, and that
 * script has no way to tell "never seeded" apart from "tenant deleted it on purpose". */
const DEFAULT_REQUIREMENT_CUSTOM_FIELDS: ReadonlyArray<{
  name: string;
  fieldType: CustomFieldType;
  isRequired: boolean;
  options: readonly string[];
}> = [{ name: "Safety Classification", fieldType: "list", isRequired: false, options: ["A", "B", "C"] }];

const DEFAULT_TEST_CASE_CUSTOM_FIELDS: ReadonlyArray<{
  name: string;
  fieldType: CustomFieldType;
  isRequired: boolean;
  options: readonly string[];
}> = [{ name: "Test Type", fieldType: "list", isRequired: true, options: ["Verification", "Validation"] }];

/** Called once, right after a tenant is created (see apps/web/src/app/api/register) -
 * same convention as seedDefaultStatuses/seedDefaultLevels. */
export async function seedDefaultCustomFields(db: TenantTx, tenantId: string): Promise<void> {
  for (const spec of [...DEFAULT_REQUIREMENT_CUSTOM_FIELDS.map((f) => ({ ...f, entityType: "requirement" as const })), ...DEFAULT_TEST_CASE_CUSTOM_FIELDS.map((f) => ({ ...f, entityType: "test_case" as const }))]) {
    const field = await createCustomFieldDefinition(db, tenantId, {
      entityType: spec.entityType,
      name: spec.name,
      fieldType: spec.fieldType,
      isRequired: spec.isRequired,
    });
    for (const option of spec.options) {
      await createCustomFieldListOption(db, tenantId, field.id, option);
    }
  }
}

// --- Field definitions -------------------------------------------------------------

export async function listCustomFieldDefinitions(db: TenantTx, tenantId: string, entityType: CustomFieldEntityType) {
  return db
    .select()
    .from(schema.customFieldDefinitions)
    .where(and(eq(schema.customFieldDefinitions.tenantId, tenantId), eq(schema.customFieldDefinitions.entityType, entityType)))
    .orderBy(asc(schema.customFieldDefinitions.sortOrder));
}

export async function getCustomFieldDefinition(db: TenantTx, tenantId: string, fieldId: string) {
  const [field] = await db
    .select()
    .from(schema.customFieldDefinitions)
    .where(and(eq(schema.customFieldDefinitions.id, fieldId), eq(schema.customFieldDefinitions.tenantId, tenantId)));
  if (!field) throw new DomainError(`custom field ${fieldId} not found`);
  return field;
}

export async function createCustomFieldDefinition(
  db: TenantTx,
  tenantId: string,
  params: { entityType: CustomFieldEntityType; name: string; fieldType: CustomFieldType; isRequired?: boolean },
) {
  const name = params.name.trim();
  if (!name) throw new DomainError("name must not be empty");
  const existing = await listCustomFieldDefinitions(db, tenantId, params.entityType);
  const nextSortOrder = existing.length > 0 ? Math.max(...existing.map((f) => f.sortOrder)) + 1 : 0;
  const [field] = await db
    .insert(schema.customFieldDefinitions)
    .values({
      tenantId,
      entityType: params.entityType,
      name,
      fieldType: params.fieldType,
      isRequired: params.isRequired ?? false,
      sortOrder: nextSortOrder,
    })
    .returning()
    .catch((err) => {
      if (isUniqueViolation(err)) {
        throw new DomainError(`a ${noun(params.entityType)} custom field named "${name}" already exists`);
      }
      throw err;
    });
  if (!field) throw new DomainError("failed to create custom field");
  return field;
}

export async function renameCustomFieldDefinition(db: TenantTx, tenantId: string, fieldId: string, name: string) {
  const trimmed = name.trim();
  if (!trimmed) throw new DomainError("name must not be empty");
  const field = await getCustomFieldDefinition(db, tenantId, fieldId);
  const [updated] = await db
    .update(schema.customFieldDefinitions)
    .set({ name: trimmed })
    .where(and(eq(schema.customFieldDefinitions.id, fieldId), eq(schema.customFieldDefinitions.tenantId, tenantId)))
    .returning()
    .catch((err) => {
      if (isUniqueViolation(err)) {
        throw new DomainError(`a ${noun(field.entityType as CustomFieldEntityType)} custom field named "${trimmed}" already exists`);
      }
      throw err;
    });
  if (!updated) throw new DomainError("rename failed");
  return updated;
}

/** Whether a value is required is a separate mutation from the name, same reasoning as
 * every other split field/action pair in this codebase (e.g. level rename vs. code). */
export async function setCustomFieldRequired(db: TenantTx, tenantId: string, fieldId: string, isRequired: boolean) {
  await getCustomFieldDefinition(db, tenantId, fieldId);
  const [updated] = await db
    .update(schema.customFieldDefinitions)
    .set({ isRequired })
    .where(and(eq(schema.customFieldDefinitions.id, fieldId), eq(schema.customFieldDefinitions.tenantId, tenantId)))
    .returning();
  if (!updated) throw new DomainError("update failed");
  return updated;
}

export async function reorderCustomFieldDefinition(db: TenantTx, tenantId: string, fieldId: string, direction: "up" | "down") {
  const field = await getCustomFieldDefinition(db, tenantId, fieldId);
  const entityType = field.entityType as CustomFieldEntityType;
  const all = await listCustomFieldDefinitions(db, tenantId, entityType);
  const index = all.findIndex((f) => f.id === fieldId);
  const swapIndex = direction === "up" ? index - 1 : index + 1;
  if (swapIndex < 0 || swapIndex >= all.length) return all;

  const current = all[index]!;
  const other = all[swapIndex]!;
  await db.update(schema.customFieldDefinitions).set({ sortOrder: other.sortOrder }).where(eq(schema.customFieldDefinitions.id, current.id));
  await db.update(schema.customFieldDefinitions).set({ sortOrder: current.sortOrder }).where(eq(schema.customFieldDefinitions.id, other.id));

  return listCustomFieldDefinitions(db, tenantId, entityType);
}

/** Deleting a definition cascades away every value ever set for it
 * (`custom_field_values.field_id` is `ON DELETE CASCADE`) - unlike deleting a level or
 * status, there's no "in use" guard here, since nothing is left dangling by removing it.
 * That this is real, permanent data loss (not just "unused, safe to remove") is the
 * caller's job to warn about - the settings UI's confirm dialog says so explicitly. */
export async function deleteCustomFieldDefinition(db: TenantTx, tenantId: string, fieldId: string) {
  await getCustomFieldDefinition(db, tenantId, fieldId);
  await db
    .delete(schema.customFieldDefinitions)
    .where(and(eq(schema.customFieldDefinitions.id, fieldId), eq(schema.customFieldDefinitions.tenantId, tenantId)));
}

// --- List options (field_type='list' only) ------------------------------------------

export async function listCustomFieldListOptions(db: TenantTx, tenantId: string, fieldId: string) {
  return db
    .select()
    .from(schema.customFieldListOptions)
    .where(and(eq(schema.customFieldListOptions.tenantId, tenantId), eq(schema.customFieldListOptions.fieldId, fieldId)))
    .orderBy(asc(schema.customFieldListOptions.sortOrder));
}

export async function createCustomFieldListOption(db: TenantTx, tenantId: string, fieldId: string, value: string) {
  const field = await getCustomFieldDefinition(db, tenantId, fieldId);
  if (field.fieldType !== "list") throw new DomainError("only a 'list' field can have options");
  const trimmed = value.trim();
  if (!trimmed) throw new DomainError("option value must not be empty");

  const existing = await listCustomFieldListOptions(db, tenantId, fieldId);
  const nextSortOrder = existing.length > 0 ? Math.max(...existing.map((o) => o.sortOrder)) + 1 : 0;
  const [option] = await db
    .insert(schema.customFieldListOptions)
    .values({ tenantId, fieldId, value: trimmed, sortOrder: nextSortOrder })
    .returning()
    .catch((err) => {
      if (isUniqueViolation(err)) throw new DomainError(`"${trimmed}" is already an option on this field`);
      throw err;
    });
  if (!option) throw new DomainError("failed to create option");
  return option;
}

/** Free to rename at any time, unlike deleting one - values reference an option by id
 * (see custom_field_values' schema comment), never its text, so nothing has to change
 * anywhere else when the label changes. */
export async function renameCustomFieldListOption(db: TenantTx, tenantId: string, optionId: string, value: string) {
  const trimmed = value.trim();
  if (!trimmed) throw new DomainError("option value must not be empty");
  const [updated] = await db
    .update(schema.customFieldListOptions)
    .set({ value: trimmed })
    .where(and(eq(schema.customFieldListOptions.id, optionId), eq(schema.customFieldListOptions.tenantId, tenantId)))
    .returning()
    .catch((err) => {
      if (isUniqueViolation(err)) throw new DomainError(`"${trimmed}" is already an option on this field`);
      throw err;
    });
  if (!updated) throw new DomainError("option not found");
  return updated;
}

export async function reorderCustomFieldListOption(db: TenantTx, tenantId: string, optionId: string, direction: "up" | "down") {
  const [option] = await db
    .select()
    .from(schema.customFieldListOptions)
    .where(and(eq(schema.customFieldListOptions.id, optionId), eq(schema.customFieldListOptions.tenantId, tenantId)));
  if (!option) throw new DomainError("option not found");

  const all = await listCustomFieldListOptions(db, tenantId, option.fieldId);
  const index = all.findIndex((o) => o.id === optionId);
  const swapIndex = direction === "up" ? index - 1 : index + 1;
  if (swapIndex < 0 || swapIndex >= all.length) return all;

  const current = all[index]!;
  const other = all[swapIndex]!;
  await db.update(schema.customFieldListOptions).set({ sortOrder: other.sortOrder }).where(eq(schema.customFieldListOptions.id, current.id));
  await db.update(schema.customFieldListOptions).set({ sortOrder: current.sortOrder }).where(eq(schema.customFieldListOptions.id, other.id));

  return listCustomFieldListOptions(db, tenantId, option.fieldId);
}

/** Blocked while any entity currently has this option selected - unlike deleting the
 * whole field (which cascades values away with it), deleting one option out from under
 * values still pointing at it would leave those values resolving to nothing. */
export async function deleteCustomFieldListOption(db: TenantTx, tenantId: string, optionId: string) {
  const [option] = await db
    .select()
    .from(schema.customFieldListOptions)
    .where(and(eq(schema.customFieldListOptions.id, optionId), eq(schema.customFieldListOptions.tenantId, tenantId)));
  if (!option) throw new DomainError("option not found");

  const [inUse] = await db
    .select({ entityId: schema.customFieldValues.entityId })
    .from(schema.customFieldValues)
    .where(and(eq(schema.customFieldValues.fieldId, option.fieldId), eq(schema.customFieldValues.value, optionId)))
    .limit(1);
  if (inUse) throw new DomainError("cannot delete an option that is currently selected on at least one item");

  await db
    .delete(schema.customFieldListOptions)
    .where(and(eq(schema.customFieldListOptions.id, optionId), eq(schema.customFieldListOptions.tenantId, tenantId)));
}

/** Idempotent, case-insensitive get-or-create for a list option's id - same normalization
 * loadCustomFieldMappingResolution/resolveCustomFieldValues use
 * (packages/integrations/spira/src/custom-fields.ts). Backs the Spira importer's
 * "auto-create missing list options" behavior (backlog item 9.25): a team migrating an
 * existing category field (e.g. Spira's own Test Case Type) shouldn't have to hand-copy
 * every distinct value into a list field's options before their first import can use it.
 * Deliberately separate from createCustomFieldListOption, which the settings UI uses and
 * which rejects a duplicate outright - a human explicitly adding an option that already
 * exists is a mistake worth surfacing, but an importer hitting the same source value
 * twice (this row and an earlier one in the same run, or a value already added by hand)
 * is normal and should just reuse it. */
export async function getOrCreateCustomFieldListOption(
  db: TenantTx,
  tenantId: string,
  fieldId: string,
  value: string,
): Promise<{ id: string; created: boolean }> {
  const trimmed = value.trim();
  const normalized = trimmed.toLowerCase();
  const findMatch = async () =>
    (await listCustomFieldListOptions(db, tenantId, fieldId)).find((o) => o.value.trim().toLowerCase() === normalized);

  const existing = await findMatch();
  if (existing) return { id: existing.id, created: false };
  try {
    const created = await createCustomFieldListOption(db, tenantId, fieldId, trimmed);
    return { id: created.id, created: true };
  } catch (err) {
    // Lost a race with another row in the same run (or a concurrent settings edit)
    // that created the same option between the lookup above and this insert - reuse it
    // rather than fail the row over what's actually just a duplicate.
    if (err instanceof DomainError) {
      const again = await findMatch();
      if (again) return { id: again.id, created: false };
    }
    throw err;
  }
}

// --- Values --------------------------------------------------------------------------

export interface CustomFieldValueInput {
  fieldId: string;
  /** Raw value from the caller - a string for short_text/long_text/date, a number (or a
   * numeric string) for integer, a boolean for boolean, and the chosen option's id
   * (a string) for list. null/undefined/"" clears the value. */
  value: string | number | boolean | null | undefined;
}

/** Validates and normalizes a raw value against its field's declared type, returning the
 * exact string this gets stored as (see `customFieldValues.value`'s schema comment for
 * the per-type encoding), or null to clear it. Throws a DomainError naming the field on
 * any mismatch. */
async function validateCustomFieldValue(
  db: TenantTx,
  tenantId: string,
  field: typeof schema.customFieldDefinitions.$inferSelect,
  raw: string | number | boolean | null | undefined,
): Promise<string | null> {
  if (raw === null || raw === undefined || raw === "") return null;

  switch (field.fieldType as CustomFieldType) {
    case "short_text":
    case "long_text": {
      const str = String(raw).trim();
      return str === "" ? null : str;
    }
    case "integer": {
      const n = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isSafeInteger(n)) throw new DomainError(`"${field.name}" must be a whole number`);
      return String(n);
    }
    case "boolean": {
      if (typeof raw === "boolean") return raw ? "true" : "false";
      if (raw === "true" || raw === "false") return raw;
      throw new DomainError(`"${field.name}" must be yes or no`);
    }
    case "date": {
      // Accept a bare "YYYY-MM-DD" (the normal case) or a full ISO datetime with that
      // date as its prefix (e.g. "2024-01-15T00:00:00.000", exactly what Spira's own
      // DateTimeValue custom property field comes back as - see readSpiraField in
      // packages/integrations/spira) - only the date portion is ever stored.
      const str = String(raw).trim();
      const datePart = str.slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart) || Number.isNaN(Date.parse(datePart))) {
        throw new DomainError(`"${field.name}" must be a valid date (YYYY-MM-DD)`);
      }
      return datePart;
    }
    case "list": {
      const optionId = String(raw).trim();
      const [option] = await db
        .select({ id: schema.customFieldListOptions.id })
        .from(schema.customFieldListOptions)
        .where(
          and(
            eq(schema.customFieldListOptions.id, optionId),
            eq(schema.customFieldListOptions.fieldId, field.id),
            eq(schema.customFieldListOptions.tenantId, tenantId),
          ),
        );
      if (!option) throw new DomainError(`"${field.name}" must be one of that field's defined options`);
      return optionId;
    }
    default:
      throw new DomainError(`unknown custom field type "${field.fieldType}"`);
  }
}

/**
 * Validates and writes the *complete* set of custom field values for one entity - every
 * definition for `entityType` is reconciled against `values` on every call (a definition
 * not mentioned in `values` is treated as cleared, not left alone), matching how the
 * create form and the detail page's edit form both always submit every field together
 * rather than one at a time. A field marked required is rejected as missing here whether
 * it's entirely absent from `values` or explicitly sent as null/empty - both mean "no
 * value", and a required field can't have one.
 *
 * Must run inside the transaction that owns `entityId` - trusts it without re-checking
 * tenant ownership, since every caller has either just created it in the same
 * transaction (createRequirement/createTestCase) or is a router endpoint that already
 * verified ownership before calling this (see requirements.ts/test-cases.ts's
 * updateCustomFieldValues).
 */
export interface SetCustomFieldValuesResult {
  /** True if at least one field's value was actually different from what was already
   * stored (a value added, cleared, or changed to something else) - false if every
   * defined field's normalized value matched what was already there, so nothing was
   * written at all. Callers that report a "created"/"updated"/"unchanged" action for the
   * whole entity (see createOrUpdateRequirementFromImport/
   * createOrUpdateTestCaseFromImport) fold this into that decision - custom field values
   * aren't versioned, but a re-import that only changed a custom field is still a real
   * change, not "unchanged". */
  changed: boolean;
}

export async function setCustomFieldValues(
  db: TenantTx,
  tenantId: string,
  entityType: CustomFieldEntityType,
  entityId: string,
  values: CustomFieldValueInput[],
): Promise<SetCustomFieldValuesResult> {
  const definitions = await listCustomFieldDefinitions(db, tenantId, entityType);
  if (definitions.length === 0) return { changed: false };
  const byId = new Map(values.map((v) => [v.fieldId, v.value]));

  // Fetched once, up front, so a call that changes nothing (the common case on a
  // re-import where only some other field differs) touches the table with a read, not a
  // write - and so `changed` can be computed precisely instead of assuming every call
  // wrote something.
  const existingRows = await db
    .select({ fieldId: schema.customFieldValues.fieldId, value: schema.customFieldValues.value })
    .from(schema.customFieldValues)
    .where(
      and(
        eq(schema.customFieldValues.entityId, entityId),
        inArray(
          schema.customFieldValues.fieldId,
          definitions.map((f) => f.id),
        ),
      ),
    );
  const existingByFieldId = new Map(existingRows.map((r) => [r.fieldId, r.value]));

  let changed = false;
  for (const field of definitions) {
    const normalized = await validateCustomFieldValue(db, tenantId, field, byId.get(field.id));
    if (field.isRequired && normalized === null) {
      throw new DomainError(`"${field.name}" is required`);
    }
    if ((existingByFieldId.get(field.id) ?? null) === normalized) continue;
    changed = true;
    if (normalized === null) {
      await db
        .delete(schema.customFieldValues)
        .where(and(eq(schema.customFieldValues.fieldId, field.id), eq(schema.customFieldValues.entityId, entityId)));
    } else {
      await db
        .insert(schema.customFieldValues)
        .values({ tenantId, fieldId: field.id, entityId, value: normalized })
        .onConflictDoUpdate({
          target: [schema.customFieldValues.fieldId, schema.customFieldValues.entityId],
          set: { value: normalized },
        });
    }
  }
  return { changed };
}

export interface CustomFieldValueView {
  fieldId: string;
  name: string;
  fieldType: CustomFieldType;
  isRequired: boolean;
  /** Raw stored value (see `customFieldValues.value`'s encoding) - null if unset. */
  value: string | null;
  /** For field_type='list' only: the option's display text (`value` holds its id, not
   * this) - null for every other type, or if the stored option no longer exists (should
   * never happen given deleteCustomFieldListOption's in-use guard; defensive only). */
  optionLabel: string | null;
}

/** Batched read for a list of entities (list/table views, the traceability matrix) - one
 * query for every value across all of them rather than N+1. Returns a map keyed by
 * entityId, each value a row per defined field in display order, whether or not that
 * entity has a value set for it yet. getCustomFieldValues (below) is this with a single
 * entity, unwrapped - the one-entity case (a detail page) doesn't need its own query
 * shape. */
export async function getCustomFieldValuesForEntities(
  db: TenantTx,
  tenantId: string,
  entityType: CustomFieldEntityType,
  entityIds: string[],
): Promise<Map<string, CustomFieldValueView[]>> {
  const definitions = await listCustomFieldDefinitions(db, tenantId, entityType);
  const result = new Map<string, CustomFieldValueView[]>(entityIds.map((id) => [id, []]));
  if (definitions.length === 0 || entityIds.length === 0) return result;

  const values = await db
    .select()
    .from(schema.customFieldValues)
    .where(and(eq(schema.customFieldValues.tenantId, tenantId), inArray(schema.customFieldValues.entityId, entityIds)));
  const valuesByEntity = new Map<string, Map<string, string | null>>();
  for (const v of values) {
    if (!valuesByEntity.has(v.entityId)) valuesByEntity.set(v.entityId, new Map());
    valuesByEntity.get(v.entityId)!.set(v.fieldId, v.value);
  }

  const listFieldIds = definitions.filter((f) => f.fieldType === "list").map((f) => f.id);
  const options = listFieldIds.length
    ? await db.select().from(schema.customFieldListOptions).where(inArray(schema.customFieldListOptions.fieldId, listFieldIds))
    : [];
  const optionById = new Map(options.map((o) => [o.id, o.value]));

  for (const entityId of entityIds) {
    const valueByFieldId = valuesByEntity.get(entityId) ?? new Map<string, string | null>();
    result.set(
      entityId,
      definitions.map((field) => {
        const value = valueByFieldId.get(field.id) ?? null;
        return {
          fieldId: field.id,
          name: field.name,
          fieldType: field.fieldType as CustomFieldType,
          isRequired: field.isRequired,
          value,
          optionLabel: field.fieldType === "list" && value ? (optionById.get(value) ?? null) : null,
        };
      }),
    );
  }
  return result;
}

export async function getCustomFieldValues(
  db: TenantTx,
  tenantId: string,
  entityType: CustomFieldEntityType,
  entityId: string,
): Promise<CustomFieldValueView[]> {
  const map = await getCustomFieldValuesForEntities(db, tenantId, entityType, [entityId]);
  return map.get(entityId) ?? [];
}
