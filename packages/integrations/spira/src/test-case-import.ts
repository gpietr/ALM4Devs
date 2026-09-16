import {
  createOrUpdateTestCaseFromImport,
  type CustomFieldValueInput,
  ensureSequenceCounterAtLeast,
  type ImportUpsertAction,
  type TestType,
} from "@galm/core";
import { type AppDb, withTenant } from "@galm/db";
import { readSpiraField, type SpiraClient, type SpiraTestCase, type SpiraTestStep } from "./client";
import {
  autoCreateMissingListOptions,
  type CustomFieldMappingResolution,
  formatAutoCreatedOptionsNote,
  loadCustomFieldMappingResolution,
  resolveCustomFieldValues,
  type UnmatchedListValue,
} from "./custom-fields";
import { parseLegacySequenceNumber } from "./legacy-id";
import { SPIRA_IMPORT_MAX_ROWS_DEFAULT, SPIRA_IMPORT_PAGE_SIZE } from "./pagination";
import { loadImportedRequirementIdMap, resolveRequirementLinks } from "./requirement-links";

/**
 * Unlike the requirement importer, only `title` is a user-chosen mapping: our test case
 * model has no case-level description field (only steps carry rich text - see
 * packages/db/src/schema.ts), so Spira's own test case Description isn't imported at all,
 * an explicit scope cut. Every step's Description and ExpectedResult are always read
 * directly (they're the two fields fundamentally being imported, not a choice), and
 * `purpose` is the one optional per-step mapping - a real Spira project used during
 * development had a custom "Purpose" text field on TestStep, which lines up neatly with
 * our own optional step-level `purpose` field.
 */
export interface TestCaseFieldMapping {
  title: string;
  purpose?: string;
  /** Optional: a custom Spira Test Case field holding a legacy/pre-migration id - same
   * mechanism and reasoning as RequirementFieldMapping.legacyId
   * (packages/integrations/spira/src/import.ts), applied to test cases instead. */
  legacyId?: string;
  /** Maps our test case custom field id (see packages/core/src/custom-fields.ts) to the
   * Spira Test Case field key to read for it - same mechanism as
   * RequirementFieldMapping.customFields (import.ts), applied to test cases. */
  customFields?: Record<string, string>;
}

export const REQUIRED_TEST_CASE_MAPPING_TARGETS = ["title"] as const;

export interface MappedTestStep {
  spiraStepId: number;
  description: string;
  expectedResult: string;
  purpose: string | null;
}

export interface MappedTestCase {
  spiraId: number;
  title: string;
  /** Shown in the preview for context only - Spira's own test case type taxonomy doesn't
   * map onto our fixed verification/validation split, so it's never written. */
  spiraTestCaseType: string | null;
  steps: MappedTestStep[];
  /** Parsed from mapping.legacyId, or null if unmapped or unparseable - see
   * TestCaseFieldMapping.legacyId. */
  requestedSequenceNumber: number | null;
  /** Resolved custom field values - always empty from previewSpiraTestCaseImport, see
   * its docstring (and previewSpiraImport's in import.ts for the full reasoning). */
  customFieldValues: CustomFieldValueInput[];
  /** Mapped list custom fields whose Spira value didn't match any of that field's own
   * options - see resolveCustomFieldValues/autoCreateMissingListOptions
   * (custom-fields.ts). Always empty from previewSpiraTestCaseImport, same reason as
   * customFieldValues. */
  unmatchedListValues: UnmatchedListValue[];
  /** Local requirement ids to link this test case to, resolved from Spira's own
   * requirement-coverage trace (SpiraClient.listTestCaseRequirementLinks) against
   * requirements already imported here - see requirement-links.ts. Fetching that trace is
   * a network call `applyTestCaseMapping` itself doesn't make (unlike custom fields, read
   * straight off the already-fetched test case object), so this starts empty here and is
   * filled in by the caller (runSpiraTestCaseImport/runOrderedSpiraTestCaseImport) right
   * after - always empty from previewSpiraTestCaseImport, same reason as
   * customFieldValues. */
  requirementIds: string[];
  /** Spira's own requirement id, for every linked requirement Spira reports that hasn't
   * been imported here (yet) - see ResolvedRequirementLinks. Same caller-fills-this-in and
   * preview-leaves-it-empty caveats as requirementIds. */
  unmappedRequirementIds: number[];
}

export function applyTestCaseMapping(
  testCase: SpiraTestCase,
  steps: SpiraTestStep[],
  mapping: TestCaseFieldMapping,
  customFieldResolution: CustomFieldMappingResolution[] = [],
): MappedTestCase {
  const resolved = resolveCustomFieldValues(testCase, customFieldResolution);
  return {
    spiraId: testCase.TestCaseId,
    title: readSpiraField(testCase, mapping.title) || `Spira test case ${testCase.TestCaseId}`,
    spiraTestCaseType: testCase.TestCaseTypeName ?? null,
    steps: [...steps]
      .sort((a, b) => a.Position - b.Position)
      .map((step) => ({
        spiraStepId: step.TestStepId,
        description: step.Description ?? "",
        expectedResult: step.ExpectedResult ?? "",
        purpose: mapping.purpose ? readSpiraField(step, mapping.purpose) : null,
      })),
    requestedSequenceNumber: mapping.legacyId
      ? parseLegacySequenceNumber(readSpiraField(testCase, mapping.legacyId))
      : null,
    customFieldValues: resolved.values,
    unmatchedListValues: resolved.unmatchedListValues,
    requirementIds: [],
    unmappedRequirementIds: [],
  };
}

/** Fetches a page of real Spira test cases (with their steps) and shows what they'd
 * become - no writes. One extra request per test case for its steps (see
 * SpiraClient.listTestSteps) - fine at preview sizes. Custom fields are never resolved
 * here (always come back empty) - see previewSpiraImport's docstring (import.ts) for why. */
export async function previewSpiraTestCaseImport(
  client: SpiraClient,
  mapping: TestCaseFieldMapping,
  limit: number,
): Promise<MappedTestCase[]> {
  const testCases = await client.listTestCases({ numberOfRows: limit });
  const mapped: MappedTestCase[] = [];
  for (const testCase of testCases) {
    const steps = await client.listTestSteps(testCase.TestCaseId);
    mapped.push(applyTestCaseMapping(testCase, steps, mapping));
  }
  return mapped;
}

export interface TestCaseImportRowResult {
  spiraId: number;
  title: string;
  testCaseId?: string;
  action?: ImportUpsertAction;
  /** Extra context for "created"/"updated" (e.g. steps created/updated/unchanged), or why
   * a row was neither (e.g. "no test steps in Spira") - not an error. */
  note?: string;
  error?: string;
}

/** What one run(-or-chunk-of-a-run) call returns: the per-row results, plus every Spira
 * requirement id this batch's test cases were linked to in Spira but that hasn't been
 * imported here yet - deduplicated and sorted, so the import screen can show "N
 * requirements referenced by these test cases weren't found - import requirements first?"
 * without re-deriving it from the row notes (backlog item 9.26). A chunked run's caller is
 * expected to union this across chunks; each chunk only reports what *that* chunk saw. */
export interface TestCaseImportRunResult {
  rows: TestCaseImportRowResult[];
  unmappedRequirementIds: number[];
}

interface RunSpiraTestCaseImportParams {
  tenantId: string;
  productId: string;
  levelId: string;
  testType: TestType;
  createdBy: string;
  mapping: TestCaseFieldMapping;
  startRow?: number;
  maxRows?: number;
}

async function importOneTestCaseRow(
  db: AppDb,
  tenantId: string,
  productId: string,
  levelId: string,
  testType: TestType,
  createdBy: string,
  mapped: MappedTestCase,
  /** Only set on the ordered (legacyId-mapped) path - see runOrderedSpiraTestCaseImport. */
  claimBefore: number | null,
  /** Same resolution loadCustomFieldMappingResolution computed once for the whole run -
   * see importOneRequirementRow's identical parameter (import.ts) for why. */
  resolution: CustomFieldMappingResolution[],
): Promise<TestCaseImportRowResult> {
  if (mapped.steps.length === 0) {
    return {
      spiraId: mapped.spiraId,
      title: mapped.title,
      error: "no test steps in Spira - skipped (a test case needs at least one step)",
    };
  }
  try {
    const { action, testCaseId, stepsCreated, stepsUpdated, stepsUnchanged, linksAdded, sequenceNumber, createdOptions } = await withTenant(
      db,
      tenantId,
      async (tx) => {
        if (claimBefore != null) {
          await ensureSequenceCounterAtLeast(tx, tenantId, productId, levelId, claimBefore);
        }
        const { customFieldValues, created } = await autoCreateMissingListOptions(
          tx,
          tenantId,
          mapped.customFieldValues,
          mapped.unmatchedListValues,
          resolution,
        );
        const result = await createOrUpdateTestCaseFromImport(tx, {
          tenantId,
          productId,
          levelId,
          testType,
          title: mapped.title,
          createdBy,
          source: "spira",
          externalId: String(mapped.spiraId),
          customFieldValues,
          requirementIds: mapped.requirementIds,
          steps: mapped.steps.map((step, index) => ({
            externalId: String(step.spiraStepId),
            description: step.description || "(imported from Spira - no step description)",
            expectedResult: step.expectedResult || "(imported from Spira - no expected result)",
            purpose: step.purpose ?? undefined,
            position: index + 1,
          })),
        });
        return { ...result, createdOptions: created };
      },
    );
    // See import.ts's identical comment - a requested number can miss its target because
    // of another row in this batch, an already-imported item, or something created
    // directly in this system; either way the row is still added with the next
    // available number instead ("duplicate IDs ignored", not a failure).
    const mismatchNote =
      action === "created" && mapped.requestedSequenceNumber != null && sequenceNumber !== mapped.requestedSequenceNumber
        ? `requested id ${mapped.requestedSequenceNumber} was already taken - assigned ${sequenceNumber} instead`
        : undefined;
    const baseNote =
      action === "updated" ? `${stepsCreated} step(s) created, ${stepsUpdated} updated, ${stepsUnchanged} unchanged` : mismatchNote;
    const createdOptionsNote = formatAutoCreatedOptionsNote(createdOptions);
    const linksNote = linksAdded > 0 ? `${linksAdded} requirement link(s) added` : undefined;
    const unmappedReqsNote =
      mapped.unmappedRequirementIds.length > 0
        ? `${mapped.unmappedRequirementIds.length} linked requirement(s) not found locally: ${mapped.unmappedRequirementIds
            .map((id) => `#${id}`)
            .join(", ")}`
        : undefined;
    const note = [baseNote, createdOptionsNote, linksNote, unmappedReqsNote].filter((n): n is string => Boolean(n)).join("; ") || undefined;
    return { spiraId: mapped.spiraId, title: mapped.title, testCaseId, action, note };
  } catch (err) {
    return { spiraId: mapped.spiraId, title: mapped.title, error: err instanceof Error ? err.message : "import failed" };
  }
}

/** Commits real TestCase (+ TestStep) rows for every Spira test case from `startRow`
 * onward, paging through the source automatically - same "import all in one click"
 * pattern as `runSpiraImport` for requirements. Continues past a per-row failure
 * (including "Spira test case has zero steps", since our model requires at least one)
 * rather than aborting the whole batch. `testType` and `levelId` are fixed choices applied
 * to every imported test case, not sourced from Spira - see the module docstring.
 *
 * **Idempotent by Spira id**: each test case (and each of its steps) records its Spira id
 * in `external_links` (see `createOrUpdateTestCaseFromImport`), so re-running this import
 * updates the same test case's steps in place instead of creating a duplicate. A step
 * removed at the source is left alone locally, never deleted - see that function's
 * docstring for why.
 *
 * **One transaction per row, not one for the whole run** - see runSpiraImport's docstring
 * (packages/integrations/spira/src/import.ts) for why: `db` is the raw connection pool,
 * and each row opens its own `withTenant` transaction.
 *
 * **Switches to the ordered mode when `mapping.legacyId` is set** - see
 * runOrderedSpiraTestCaseImport, and RequirementFieldMapping.legacyId in import.ts for
 * the underlying reasoning (identical here, applied to test cases). */
export async function runSpiraTestCaseImport(
  db: AppDb,
  client: SpiraClient,
  params: RunSpiraTestCaseImportParams,
): Promise<TestCaseImportRunResult> {
  if (params.mapping.legacyId) {
    return runOrderedSpiraTestCaseImport(db, client, params);
  }

  const customFieldResolution = await loadCustomFieldMappingResolution(
    db,
    params.tenantId,
    "test_case",
    params.mapping.customFields,
  );
  const requirementIdMap = await loadImportedRequirementIdMap(db, params.tenantId);
  const unmappedRequirementIds = new Set<number>();

  const maxRows = params.maxRows ?? SPIRA_IMPORT_MAX_ROWS_DEFAULT;
  const results: TestCaseImportRowResult[] = [];
  let startRow = params.startRow ?? 1;

  // See runSpiraImport's identical comment (import.ts) - a page request is capped to
  // whatever's left of `maxRows`, so a small caller-supplied `maxRows` genuinely bounds
  // how many rows this one call processes (the import UI's "x/n processed" chunking).
  while (results.length < maxRows) {
    const pageSize = Math.min(SPIRA_IMPORT_PAGE_SIZE, maxRows - results.length);
    const testCases = await client.listTestCases({ startRow, numberOfRows: pageSize });
    if (testCases.length === 0) break;

    for (const raw of testCases) {
      const title = readSpiraField(raw, params.mapping.title) || `Spira test case ${raw.TestCaseId}`;
      let mapped: MappedTestCase;
      try {
        const [steps, spiraRequirementIds] = await Promise.all([
          client.listTestSteps(raw.TestCaseId),
          client.listTestCaseRequirementLinks(raw.TestCaseId),
        ]);
        mapped = applyTestCaseMapping(raw, steps, params.mapping, customFieldResolution);
        const linkResolution = resolveRequirementLinks(spiraRequirementIds, requirementIdMap);
        mapped.requirementIds = linkResolution.requirementIds;
        mapped.unmappedRequirementIds = linkResolution.unmappedRequirementIds;
        for (const id of linkResolution.unmappedRequirementIds) unmappedRequirementIds.add(id);
      } catch (err) {
        results.push({ spiraId: raw.TestCaseId, title, error: err instanceof Error ? err.message : "failed to fetch steps" });
        continue;
      }
      results.push(
        await importOneTestCaseRow(
          db,
          params.tenantId,
          params.productId,
          params.levelId,
          params.testType,
          params.createdBy,
          mapped,
          null,
          customFieldResolution,
        ),
      );
    }

    if (testCases.length < pageSize) break;
    startRow += pageSize;
  }

  return { rows: results, unmappedRequirementIds: [...unmappedRequirementIds].sort((a, b) => a - b) };
}

/** See runOrderedSpiraImport (packages/integrations/spira/src/import.ts) for the full
 * reasoning - identical mechanism applied to test cases: fetch every row (and its steps)
 * up front, sort by the parsed legacy number ascending, create in that order with the
 * counter bumped just ahead of each one. Works fine into a level that already has test
 * cases in it: an already-imported one is updated in place (its own sequence number
 * untouched), a genuinely new one claims its requested number if free, and if that
 * number is already taken by anything - another row in this batch, a prior import, or a
 * test case created directly in this system - it's still added, just with the next
 * available number instead (see importOneTestCaseRow's `mismatchNote`). */
async function runOrderedSpiraTestCaseImport(
  db: AppDb,
  client: SpiraClient,
  params: RunSpiraTestCaseImportParams,
): Promise<TestCaseImportRunResult> {
  const customFieldResolution = await loadCustomFieldMappingResolution(
    db,
    params.tenantId,
    "test_case",
    params.mapping.customFields,
  );
  const requirementIdMap = await loadImportedRequirementIdMap(db, params.tenantId);
  const unmappedRequirementIds = new Set<number>();

  const maxRows = params.maxRows ?? SPIRA_IMPORT_MAX_ROWS_DEFAULT;
  const fetched: MappedTestCase[] = [];
  const stepFetchErrors: TestCaseImportRowResult[] = [];
  let startRow = 1;
  while (fetched.length + stepFetchErrors.length < maxRows) {
    const page = await client.listTestCases({ startRow, numberOfRows: SPIRA_IMPORT_PAGE_SIZE });
    if (page.length === 0) break;
    for (const raw of page) {
      const title = readSpiraField(raw, params.mapping.title) || `Spira test case ${raw.TestCaseId}`;
      try {
        const [steps, spiraRequirementIds] = await Promise.all([
          client.listTestSteps(raw.TestCaseId),
          client.listTestCaseRequirementLinks(raw.TestCaseId),
        ]);
        const mapped = applyTestCaseMapping(raw, steps, params.mapping, customFieldResolution);
        const linkResolution = resolveRequirementLinks(spiraRequirementIds, requirementIdMap);
        mapped.requirementIds = linkResolution.requirementIds;
        mapped.unmappedRequirementIds = linkResolution.unmappedRequirementIds;
        for (const id of linkResolution.unmappedRequirementIds) unmappedRequirementIds.add(id);
        fetched.push(mapped);
      } catch (err) {
        stepFetchErrors.push({ spiraId: raw.TestCaseId, title, error: err instanceof Error ? err.message : "failed to fetch steps" });
      }
    }
    if (page.length < SPIRA_IMPORT_PAGE_SIZE) break;
    startRow += SPIRA_IMPORT_PAGE_SIZE;
  }
  const rows = fetched.slice(0, maxRows);

  const withNumber = rows.filter((r): r is MappedTestCase & { requestedSequenceNumber: number } => r.requestedSequenceNumber != null);
  const withoutNumber = rows.filter((r) => r.requestedSequenceNumber == null);
  withNumber.sort((a, b) => a.requestedSequenceNumber - b.requestedSequenceNumber);
  const ordered = [...withNumber, ...withoutNumber];

  const results: TestCaseImportRowResult[] = [...stepFetchErrors];
  for (const mapped of ordered) {
    const claimBefore = mapped.requestedSequenceNumber != null ? mapped.requestedSequenceNumber - 1 : null;
    results.push(
      await importOneTestCaseRow(
        db,
        params.tenantId,
        params.productId,
        params.levelId,
        params.testType,
        params.createdBy,
        mapped,
        claimBefore,
        customFieldResolution,
      ),
    );
  }
  return { rows: results, unmappedRequirementIds: [...unmappedRequirementIds].sort((a, b) => a - b) };
}
