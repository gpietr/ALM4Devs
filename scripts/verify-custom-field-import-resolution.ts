import {
  createOrUpdateRequirementFromImport,
  createRequirement,
  getCustomFieldValues,
  seedDefaultLevels,
  seedDefaultStatuses,
} from "@galm/core";
import { createAdminDb, createAppDb, schema, withTenant } from "@galm/db";
import {
  autoCreateMissingListOptions,
  formatAutoCreatedOptionsNote,
  loadCustomFieldMappingResolution,
  readSpiraField,
  resolveCustomFieldValues,
} from "@galm/integrations-spira";
import { and, eq } from "drizzle-orm";

/**
 * Direct verification of the Spira-import custom-field mapping resolution
 * (packages/integrations/spira/src/custom-fields.ts) - run for real against a live
 * database, same pattern as verify-legacy-id-import.ts.
 *
 * Not covered by tests/e2e.test.ts: same reasoning as verify-legacy-id-import.ts - this
 * logic only runs inside the Spira import path, which needs a real or mocked Spira server
 * to exercise end to end (no Spira e2e coverage exists in this project). What's testable
 * without one is loadCustomFieldMappingResolution + resolveCustomFieldValues against a
 * fake but realistically-shaped Spira artifact object, followed by feeding the resolved
 * values into the real createRequirement to confirm the whole chain (parse Spira value ->
 * resolve list option -> validate -> store -> read back) actually works end to end.
 *
 * Usage: DATABASE_MIGRATION_URL=... DATABASE_URL=... bun run scripts/verify-custom-field-import-resolution.ts
 */
async function main() {
  const admin = createAdminDb();
  const app = createAppDb();
  let failed = false;

  function check(label: string, condition: boolean) {
    console.log(`${condition ? "OK  " : "FAIL"} - ${label}`);
    if (!condition) failed = true;
  }

  const [tenant] = await admin
    .insert(schema.tenants)
    .values({ name: `Custom Field Import Resolution Verification ${Date.now()}` })
    .returning();
  if (!tenant) throw new Error("failed to insert tenant");

  await withTenant(app, tenant.id, async (tx) => {
    await seedDefaultStatuses(tx, tenant.id);
    await seedDefaultLevels(tx, tenant.id);
  });

  const [product] = await withTenant(app, tenant.id, (tx) =>
    tx.insert(schema.products).values({ tenantId: tenant.id, name: "P" }).returning(),
  );
  if (!product) throw new Error("failed to insert product");
  const [author] = await admin
    .insert(schema.user)
    .values({
      id: crypto.randomUUID(),
      tenantId: tenant.id,
      name: "Verifier",
      email: `verify-custom-field-import-${Date.now()}@example.com`,
    })
    .returning();
  if (!author) throw new Error("failed to insert user");

  const [reqLevel] = await withTenant(app, tenant.id, (tx) =>
    tx.select().from(schema.levels).where(and(eq(schema.levels.tenantId, tenant.id), eq(schema.levels.kind, "requirement"))),
  );
  if (!reqLevel) throw new Error("level not seeded");

  // --- Define two custom fields: a short_text and a list --------------------------------

  const [ownerField] = await withTenant(app, tenant.id, (tx) =>
    tx
      .insert(schema.customFieldDefinitions)
      .values({ tenantId: tenant.id, entityType: "requirement", name: "Owner", fieldType: "short_text", sortOrder: 0 })
      .returning(),
  );
  const [priorityField] = await withTenant(app, tenant.id, (tx) =>
    tx
      .insert(schema.customFieldDefinitions)
      .values({ tenantId: tenant.id, entityType: "requirement", name: "Priority", fieldType: "list", sortOrder: 1 })
      .returning(),
  );
  if (!ownerField || !priorityField) throw new Error("failed to create custom fields");

  const [highOption] = await withTenant(app, tenant.id, (tx) =>
    tx
      .insert(schema.customFieldListOptions)
      .values({ tenantId: tenant.id, fieldId: priorityField.id, value: "High", sortOrder: 0 })
      .returning(),
  );
  const [lowOption] = await withTenant(app, tenant.id, (tx) =>
    tx
      .insert(schema.customFieldListOptions)
      .values({ tenantId: tenant.id, fieldId: priorityField.id, value: "Low", sortOrder: 1 })
      .returning(),
  );
  if (!highOption || !lowOption) throw new Error("failed to create options");

  // --- Load the resolution, exactly as runSpiraImport would ----------------------------

  const customFieldsMapping = { [ownerField.id]: "OwnerName", [priorityField.id]: "PriorityText" };
  const resolution = await loadCustomFieldMappingResolution(app, tenant.id, "requirement", customFieldsMapping);
  check("resolution has one entry per mapped field", resolution.length === 2);

  const priorityResolution = resolution.find((r) => r.fieldId === priorityField.id);
  check(
    "list field's resolution has an option id for each known option text (case-insensitive)",
    priorityResolution?.optionIdByNormalizedText.get("high") === highOption.id &&
      priorityResolution?.optionIdByNormalizedText.get("low") === lowOption.id,
  );

  // A mapped field id that no longer exists (deleted since the mapping UI was configured)
  // is silently skipped, not an error.
  const withStaleField = await loadCustomFieldMappingResolution(app, tenant.id, "requirement", {
    ...customFieldsMapping,
    [crypto.randomUUID()]: "SomeStaleField",
  });
  check("a stale/deleted mapped field id is silently skipped, not included", withStaleField.length === 2);

  // --- Resolve against a fake Spira artifact --------------------------------------------

  const fakeArtifact = { RequirementId: 999, OwnerName: "Alice", PriorityText: "high" }; // note: different case than the option
  const { values: resolvedValues } = resolveCustomFieldValues(fakeArtifact, resolution);
  const ownerValue = resolvedValues.find((v) => v.fieldId === ownerField.id);
  const priorityValue = resolvedValues.find((v) => v.fieldId === priorityField.id);
  check("short_text resolves to the raw Spira text", ownerValue?.value === "Alice");
  check(
    "list resolves to the matching option's id despite a case difference ('high' vs 'High')",
    priorityValue?.value === highOption.id,
  );

  const fakeArtifactUnknownPriority = { RequirementId: 998, OwnerName: "Bob", PriorityText: "Medium" };
  const resolvedUnknown = resolveCustomFieldValues(fakeArtifactUnknownPriority, resolution);
  check(
    "list resolves to null when the Spira text doesn't match any defined option",
    resolvedUnknown.values.find((v) => v.fieldId === priorityField.id)?.value === null,
  );
  check(
    "an unmatched list value is reported back, not just silently nulled",
    resolvedUnknown.unmatchedListValues.length === 1 &&
      resolvedUnknown.unmatchedListValues[0]?.fieldId === priorityField.id &&
      resolvedUnknown.unmatchedListValues[0]?.fieldName === "Priority" &&
      resolvedUnknown.unmatchedListValues[0]?.rawValue === "Medium",
  );
  const resolvedMatching = resolveCustomFieldValues(fakeArtifact, resolution);
  const autoCreateForMatching = await withTenant(app, tenant.id, (tx) =>
    autoCreateMissingListOptions(tx, tenant.id, resolvedMatching.values, resolvedMatching.unmatchedListValues, resolution),
  );
  check(
    "a resolved (matching) list value produces no auto-created-options note",
    formatAutoCreatedOptionsNote(autoCreateForMatching.created) === undefined,
  );

  // --- backlog item 9.25: the user asked "can't you automatically add the missing
  // --- values when importing?" after 9.24 shipped a warning note but still required
  // --- hand-adding every option first - autoCreateMissingListOptions creates the
  // --- missing option itself, in the same transaction as the row's own write. ---------

  const autoCreateResult = await withTenant(app, tenant.id, (tx) =>
    autoCreateMissingListOptions(tx, tenant.id, resolvedUnknown.values, resolvedUnknown.unmatchedListValues, resolution),
  );
  const priorityAfterAutoCreate = autoCreateResult.customFieldValues.find((v) => v.fieldId === priorityField.id);
  check(
    "autoCreateMissingListOptions swaps a real new option id in for the previously-null value",
    typeof priorityAfterAutoCreate?.value === "string" && priorityAfterAutoCreate.value !== null,
  );
  check(
    "autoCreateMissingListOptions reports what it created, by field name and value",
    autoCreateResult.created.length === 1 &&
      autoCreateResult.created[0]?.fieldName === "Priority" &&
      autoCreateResult.created[0]?.value === "Medium",
  );
  check(
    "formatAutoCreatedOptionsNote renders a human-readable note naming the field and the newly-created value",
    formatAutoCreatedOptionsNote(autoCreateResult.created) === `created new option "Medium" for "Priority"`,
  );

  const newOptionId = priorityAfterAutoCreate?.value as string;
  const [newOptionRow] = await withTenant(app, tenant.id, (tx) =>
    tx.select().from(schema.customFieldListOptions).where(eq(schema.customFieldListOptions.id, newOptionId)),
  );
  check(
    "the auto-created option is a real row in custom_field_list_options, not just an in-memory id",
    newOptionRow?.fieldId === priorityField.id && newOptionRow?.value === "Medium",
  );

  // Same value, different case, later in the same run: resolveCustomFieldValues now
  // matches it directly (no longer "unmatched") because autoCreateMissingListOptions
  // mutated `resolution`'s shared option map in place - the whole point of doing it that
  // way, so a value repeated across many rows in one import only ever creates one option.
  const fakeArtifactRepeatedMedium = { RequirementId: 996, OwnerName: "Carol", PriorityText: "MEDIUM" };
  const resolvedRepeated = resolveCustomFieldValues(fakeArtifactRepeatedMedium, resolution);
  check(
    "a value auto-created for an earlier row is reused (not re-created) by a later row in the same run",
    resolvedRepeated.unmatchedListValues.length === 0 &&
      resolvedRepeated.values.find((v) => v.fieldId === priorityField.id)?.value === newOptionId,
  );

  // Calling autoCreateMissingListOptions again for a value that's now matched (nothing in
  // unmatchedListValues) is a correct no-op - already exercised by every row after the
  // first, but worth an explicit check: it must never create a second "Medium" option.
  const secondAutoCreate = await withTenant(app, tenant.id, (tx) =>
    autoCreateMissingListOptions(tx, tenant.id, resolvedRepeated.values, resolvedRepeated.unmatchedListValues, resolution),
  );
  check("no unmatched values left means nothing new is created", secondAutoCreate.created.length === 0);
  const mediumOptionRows = await withTenant(app, tenant.id, (tx) =>
    tx
      .select()
      .from(schema.customFieldListOptions)
      .where(and(eq(schema.customFieldListOptions.fieldId, priorityField.id), eq(schema.customFieldListOptions.value, "Medium"))),
  );
  check("exactly one 'Medium' option exists, not a duplicate per row", mediumOptionRows.length === 1);

  // --- The actual bug this section guards against: a Spira custom property's real value
  // --- lives under a TYPE-SPECIFIC key (IntegerValue/BooleanValue/DateTimeValue/
  // --- DecimalValue), not always StringValue - reading only StringValue meant every
  // --- non-text Spira custom field silently resolved to null, forever, with no error at
  // --- all: exactly "I mapped it and nothing updated." -----------------------------------

  check(
    "readSpiraField reads a custom property's IntegerValue when StringValue is absent",
    readSpiraField({ CustomProperties: [{ PropertyNumber: 20, IntegerValue: 42 }] }, "custom_20") === "42",
  );
  check(
    "readSpiraField reads a custom property's BooleanValue, including the falsy value 'false' itself",
    readSpiraField({ CustomProperties: [{ PropertyNumber: 21, BooleanValue: false }] }, "custom_21") === "false",
  );
  check(
    "readSpiraField reads a custom property's DateTimeValue",
    readSpiraField({ CustomProperties: [{ PropertyNumber: 22, DateTimeValue: "2026-03-01T00:00:00.000" }] }, "custom_22") ===
      "2026-03-01T00:00:00.000",
  );
  check(
    "readSpiraField reads a custom property's DecimalValue",
    readSpiraField({ CustomProperties: [{ PropertyNumber: 23, DecimalValue: 3.5 }] }, "custom_23") === "3.5",
  );
  check(
    "readSpiraField still returns null for a custom property with no value set at all",
    readSpiraField({ CustomProperties: [{ PropertyNumber: 24 }] }, "custom_24") === null,
  );

  // Full chain, for an integer and a boolean field, through the real create + validate +
  // read path - including that a full Spira DateTimeValue ("...T00:00:00.000") is
  // accepted by our own 'date' field type, not just a bare "YYYY-MM-DD".
  const [pointsField] = await withTenant(app, tenant.id, (tx) =>
    tx
      .insert(schema.customFieldDefinitions)
      .values({ tenantId: tenant.id, entityType: "requirement", name: "Story Points", fieldType: "integer", sortOrder: 2 })
      .returning(),
  );
  const [criticalField] = await withTenant(app, tenant.id, (tx) =>
    tx
      .insert(schema.customFieldDefinitions)
      .values({ tenantId: tenant.id, entityType: "requirement", name: "Is Critical", fieldType: "boolean", sortOrder: 3 })
      .returning(),
  );
  const [dueDateField] = await withTenant(app, tenant.id, (tx) =>
    tx
      .insert(schema.customFieldDefinitions)
      .values({ tenantId: tenant.id, entityType: "requirement", name: "Due Date", fieldType: "date", sortOrder: 4 })
      .returning(),
  );
  if (!pointsField || !criticalField || !dueDateField) throw new Error("failed to create typed custom fields");

  const typedResolution = await loadCustomFieldMappingResolution(app, tenant.id, "requirement", {
    [pointsField.id]: "custom_20",
    [criticalField.id]: "custom_21",
    [dueDateField.id]: "custom_22",
  });
  const fakeArtifactTyped = {
    RequirementId: 997,
    CustomProperties: [
      { PropertyNumber: 20, IntegerValue: 8 },
      { PropertyNumber: 21, BooleanValue: true },
      { PropertyNumber: 22, DateTimeValue: "2026-06-15T00:00:00.000" },
    ],
  };
  const { values: typedResolved } = resolveCustomFieldValues(fakeArtifactTyped, typedResolution);

  const { requirement: typedRequirement } = await withTenant(app, tenant.id, (tx) =>
    createRequirement(tx, {
      tenantId: tenant.id,
      productId: product.id,
      levelId: reqLevel.id,
      title: "Typed custom fields via IntegerValue/BooleanValue/DateTimeValue",
      description: "d",
      createdBy: author.id,
      customFieldValues: typedResolved,
    }),
  );
  const typedReadBack = await withTenant(app, tenant.id, (tx) =>
    getCustomFieldValues(tx, tenant.id, "requirement", typedRequirement.id),
  );
  check(
    "end to end: an integer field fed from IntegerValue round-trips correctly",
    typedReadBack.find((v) => v.fieldId === pointsField.id)?.value === "8",
  );
  check(
    "end to end: a boolean field fed from BooleanValue round-trips correctly",
    typedReadBack.find((v) => v.fieldId === criticalField.id)?.value === "true",
  );
  check(
    "end to end: a date field fed from Spira's full DateTimeValue is normalized to just the date",
    typedReadBack.find((v) => v.fieldId === dueDateField.id)?.value === "2026-06-15",
  );

  // --- Feed the resolved values through the real create path and read them back --------

  const { requirement } = await withTenant(app, tenant.id, (tx) =>
    createRequirement(tx, {
      tenantId: tenant.id,
      productId: product.id,
      levelId: reqLevel.id,
      title: "Imported via resolution",
      description: "d",
      createdBy: author.id,
      customFieldValues: resolvedValues,
    }),
  );
  const readBack = await withTenant(app, tenant.id, (tx) => getCustomFieldValues(tx, tenant.id, "requirement", requirement.id));
  const ownerReadBack = readBack.find((v) => v.fieldId === ownerField.id);
  const priorityReadBack = readBack.find((v) => v.fieldId === priorityField.id);
  check("end to end: Owner value round-trips through create + read", ownerReadBack?.value === "Alice");
  check(
    "end to end: Priority resolves to the option's real label on read, not its raw id",
    priorityReadBack?.optionLabel === "High",
  );

  // --- Real bug this section guards against: a re-import that only changes a custom
  // --- field value (title/description identical) must report "updated", not
  // --- "unchanged" - exactly the scenario of mapping a field for the first time against
  // --- rows already imported before. setCustomFieldValues actually wrote the value
  // --- correctly even before this fix; only the *reported action* was wrong, silently
  // --- telling the user "0 updated" while the data was fine. ------------------------

  const firstPass = await withTenant(app, tenant.id, (tx) =>
    createOrUpdateRequirementFromImport(tx, {
      tenantId: tenant.id,
      productId: product.id,
      levelId: reqLevel.id,
      title: "Action Classification Check",
      description: "same description throughout",
      createdBy: author.id,
      source: "spira",
      externalId: "77777",
      customFieldValues: [{ fieldId: ownerField.id, value: "Carol" }],
    }),
  );
  check("first import creates the requirement", firstPass.action === "created");

  const sameCustomFieldValueAgain = await withTenant(app, tenant.id, (tx) =>
    createOrUpdateRequirementFromImport(tx, {
      tenantId: tenant.id,
      productId: product.id,
      levelId: reqLevel.id,
      title: "Action Classification Check",
      description: "same description throughout",
      createdBy: author.id,
      source: "spira",
      externalId: "77777",
      customFieldValues: [{ fieldId: ownerField.id, value: "Carol" }],
    }),
  );
  check(
    "re-importing with truly nothing different (same title/description/custom field) reports 'unchanged'",
    sameCustomFieldValueAgain.action === "unchanged",
  );

  const customFieldOnlyChange = await withTenant(app, tenant.id, (tx) =>
    createOrUpdateRequirementFromImport(tx, {
      tenantId: tenant.id,
      productId: product.id,
      levelId: reqLevel.id,
      title: "Action Classification Check",
      description: "same description throughout",
      createdBy: author.id,
      source: "spira",
      externalId: "77777",
      customFieldValues: [{ fieldId: ownerField.id, value: "Dave" }],
    }),
  );
  check(
    "re-importing with only a custom field value changed (title/description identical) reports 'updated', not 'unchanged'",
    customFieldOnlyChange.action === "updated",
  );
  const ownerAfterCustomFieldOnlyChange = await withTenant(app, tenant.id, (tx) =>
    getCustomFieldValues(tx, tenant.id, "requirement", firstPass.requirementId),
  );
  check(
    "the changed custom field value was actually written, matching the 'updated' report",
    ownerAfterCustomFieldOnlyChange.find((v) => v.fieldId === ownerField.id)?.value === "Dave",
  );

  console.log(failed ? "\nFAILED" : "\nAll checks passed.");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
