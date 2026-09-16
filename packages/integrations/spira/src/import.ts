import {
  createOrUpdateRequirementFromImport,
  type CustomFieldValueInput,
  ensureSequenceCounterAtLeast,
  type ImportUpsertAction,
} from "@galm/core";
import { type AppDb, withTenant } from "@galm/db";
import sanitizeHtml from "sanitize-html";
import { readSpiraField, type SpiraClient, type SpiraRequirement } from "./client";
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

/**
 * Spira's own Description field is typically rich HTML, but our `description` field
 * predates rich-text support (unlike `background`, which is sanitized-but-formatted HTML
 * - see packages/core/src/rich-text.ts) and renders as plain text. Mapping Spira's raw
 * HTML straight into it would show literal tags in the UI. Stripping all markup here
 * (not just sanitizing - `allowedTags: []` removes every tag, keeping only the text)
 * keeps the result readable; the *content* isn't lost, just the formatting, which
 * `background` exists to carry when it matters.
 */
function stripHtmlToPlainText(value: string | null): string {
  if (!value) return "";
  // Block-level closing tags become a space before stripping - otherwise adjacent
  // elements (e.g. consecutive <li>s) collapse straight into each other with no
  // separator at all, which is confusing even though no content is actually lost.
  const withSeparators = value.replace(/<\/(p|li|div|h[1-6]|br|tr)\s*>/gi, "$& ");
  return sanitizeHtml(withSeparators, { allowedTags: [], allowedAttributes: {} })
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Which Spira field key (see client.ts's SpiraFieldDefinition) feeds which of our
 * requirement fields. `title` and `description` are required to satisfy our own schema;
 * everything else is optional and simply left unset when unmapped or empty on the source
 * row - a missing optional value never fails the row.
 */
export interface RequirementFieldMapping {
  title: string;
  description: string;
  background?: string;
  /** Optional: a custom Spira field holding a legacy/pre-migration id (e.g. a team's own
   * "ID" field from before they adopted this system). When mapped, `runSpiraImport`
   * switches to its ordered mode: every row is fetched up front, sorted by the number
   * parsed from this field, and created in that order with the local counter bumped
   * ahead of each one - so the imported requirement's id here matches the number the
   * team already knows, instead of starting a fresh count from 1. Only works importing
   * into a (product, level) with nothing in it yet - see runSpiraImport's docstring for
   * why, and what happens if that's not the case. */
  legacyId?: string;
  /** Maps our requirement custom field id (see packages/core/src/custom-fields.ts) to
   * the Spira field key to read for it - only fields the tenant has actually defined for
   * requirements are ever offered in the mapping UI. Resolved once per import run via
   * loadCustomFieldMappingResolution, not per row - see runSpiraImport. */
  customFields?: Record<string, string>;
}

export const REQUIRED_MAPPING_TARGETS = ["title", "description"] as const;

export interface MappedRequirement {
  spiraId: number;
  title: string;
  description: string;
  background: string | null;
  /** Parsed from mapping.legacyId, or null if unmapped or unparseable - see
   * RequirementFieldMapping.legacyId. Shown in the preview so a team can confirm the
   * number it extracted before running the real import. */
  requestedSequenceNumber: number | null;
  /** Resolved custom field values (empty when `mapping.customFields` is unmapped or, in
   * previewSpiraImport's case, always - see its own docstring for why preview doesn't
   * resolve list options). Passed straight through to createOrUpdateRequirementFromImport
   * at write time. */
  customFieldValues: CustomFieldValueInput[];
  /** Mapped list custom fields whose Spira value didn't match any of that field's own
   * options - see resolveCustomFieldValues/autoCreateMissingListOptions. Always empty
   * from previewSpiraImport, same reason as customFieldValues above. */
  unmatchedListValues: UnmatchedListValue[];
}

export function applyMapping(
  requirement: SpiraRequirement,
  mapping: RequirementFieldMapping,
  customFieldResolution: CustomFieldMappingResolution[] = [],
): MappedRequirement {
  const resolved = resolveCustomFieldValues(requirement, customFieldResolution);
  return {
    spiraId: requirement.RequirementId,
    title: readSpiraField(requirement, mapping.title) || `Spira requirement ${requirement.RequirementId}`,
    description: stripHtmlToPlainText(readSpiraField(requirement, mapping.description)),
    background: mapping.background ? readSpiraField(requirement, mapping.background) : null,
    requestedSequenceNumber: mapping.legacyId
      ? parseLegacySequenceNumber(readSpiraField(requirement, mapping.legacyId))
      : null,
    customFieldValues: resolved.values,
    unmatchedListValues: resolved.unmatchedListValues,
  };
}

/** Fetches a page of real Spira requirements and shows what they'd become - no writes.
 * This is the "let me see how it looks with my Spira info" step.
 *
 * `customFieldValues` always comes back empty here - resolving custom fields needs a DB
 * read (this tenant's field definitions, and a list field's option rows), and preview
 * intentionally stays a pure, DB-free Spira read so it can't itself fail on anything but
 * a Spira API problem. The real run (runSpiraImport) does the full resolution; mapped
 * custom fields still show correctly there, just not in this preview step. */
export async function previewSpiraImport(
  client: SpiraClient,
  mapping: RequirementFieldMapping,
  limit: number,
): Promise<MappedRequirement[]> {
  const requirements = await client.listRequirements({ numberOfRows: limit });
  return requirements.map((r) => applyMapping(r, mapping));
}

export interface ImportRowResult {
  spiraId: number;
  title: string;
  requirementId?: string;
  action?: ImportUpsertAction;
  /** Why an "unchanged"/"skipped" row wasn't written, or why an update didn't happen
   * (e.g. the existing requirement has moved past Draft) - not an error. */
  note?: string;
  error?: string;
}

interface RunSpiraImportParams {
  tenantId: string;
  productId: string;
  levelId: string;
  createdBy: string;
  mapping: RequirementFieldMapping;
  startRow?: number;
  maxRows?: number;
}

async function importOneRequirementRow(
  db: AppDb,
  tenantId: string,
  productId: string,
  levelId: string,
  createdBy: string,
  mapped: MappedRequirement,
  /** Only set on the ordered (legacyId-mapped) path - see runOrderedSpiraImport. Bumps
   * the counter just ahead of the requested number, in the same transaction as the
   * create, before handing off to the normal auto-incrementing create path. */
  claimBefore: number | null,
  /** Same resolution loadCustomFieldMappingResolution computed once for the whole run -
   * needed here (not just at resolve time) so autoCreateMissingListOptions can create a
   * missing list option inside this row's own transaction and update the shared
   * option-lookup map for every row after it. */
  resolution: CustomFieldMappingResolution[],
): Promise<ImportRowResult> {
  try {
    const { action, requirementId, note, sequenceNumber, createdOptions } = await withTenant(db, tenantId, async (tx) => {
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
      const result = await createOrUpdateRequirementFromImport(tx, {
        tenantId,
        productId,
        levelId,
        title: mapped.title,
        description: mapped.description || "(imported from Spira - no description mapped)",
        background: mapped.background,
        createdBy,
        source: "spira",
        externalId: String(mapped.spiraId),
        customFieldValues,
      });
      return { ...result, createdOptions: created };
    });
    // A requested number can still miss its exact target on the ordered path - two
    // source rows claiming the same legacy id, or a number already taken by something
    // that existed here before this run (another import, or an organically-created
    // item) - not an error, just worth saying so in the result rather than silently
    // landing elsewhere. This is the "duplicate IDs ignored" behavior: the row still
    // gets created, just with the next available number instead of the one requested.
    const mismatchNote =
      action === "created" && mapped.requestedSequenceNumber != null && sequenceNumber !== mapped.requestedSequenceNumber
        ? `requested id ${mapped.requestedSequenceNumber} was already taken - assigned ${sequenceNumber} instead`
        : undefined;
    const createdOptionsNote = formatAutoCreatedOptionsNote(createdOptions);
    const combinedNote = [note ?? mismatchNote, createdOptionsNote].filter((n): n is string => Boolean(n)).join("; ");
    return { spiraId: mapped.spiraId, title: mapped.title, requirementId, action, note: combinedNote || undefined };
  } catch (err) {
    return { spiraId: mapped.spiraId, title: mapped.title, error: err instanceof Error ? err.message : "import failed" };
  }
}

/** Commits real Requirement rows for every Spira requirement from `startRow` onward,
 * paging through the source automatically (stops when a page comes back shorter than
 * `IMPORT_PAGE_SIZE`, i.e. the last page) - "import all" needs one click, not one click
 * per 50 rows. Continues past a per-row failure (e.g. one malformed record) rather than
 * aborting the whole batch - the per-row result list is how the caller finds out what
 * actually happened. `startRow` stays an optional override so a run that was interrupted
 * partway (e.g. a transient network error) can be resumed from where it left off, rather
 * than re-importing already-created rows; `maxRows` is a safety cap against a runaway loop
 * on an unexpectedly huge or misbehaving project, not a normal-path limit.
 *
 * **Idempotent by Spira id**: each row records its Spira `RequirementId` in
 * `external_links` (see `createOrUpdateRequirementFromImport`), so re-running this import
 * updates the same requirement instead of creating a duplicate - and, since the id is
 * stored either way, is the foundation a future sync-*back* feature would need (not built
 * here; see that function's docstring).
 *
 * **One transaction per row, not one for the whole run**: `db` is the raw connection
 * pool, and each row opens its own `withTenant` transaction rather than the caller
 * wrapping the entire (potentially thousands-of-rows, minutes-long) run in a single one.
 * Two real problems that caused: first, `nextSequenceNumber`'s counter row for this
 * (product, level) - and, via the audit-log trigger's advisory lock, every audit-writing
 * mutation in every tenant - would stay locked for the whole run instead of one row at a
 * time. Second, and worse, the per-row try/catch below didn't actually contain failures:
 * Postgres aborts an entire transaction after any failed statement within it, so once one
 * row failed, every later row in the same transaction failed too with "current
 * transaction is aborted", not its own real error.
 *
 * **Switches to the ordered mode when `mapping.legacyId` is set** - see
 * runOrderedSpiraImport. */
export async function runSpiraImport(db: AppDb, client: SpiraClient, params: RunSpiraImportParams): Promise<ImportRowResult[]> {
  if (params.mapping.legacyId) {
    return runOrderedSpiraImport(db, client, params);
  }

  const customFieldResolution = await loadCustomFieldMappingResolution(
    db,
    params.tenantId,
    "requirement",
    params.mapping.customFields,
  );

  const maxRows = params.maxRows ?? SPIRA_IMPORT_MAX_ROWS_DEFAULT;
  const results: ImportRowResult[] = [];
  let startRow = params.startRow ?? 1;

  // Each page request is capped to whatever's left of `maxRows`, not always the full
  // SPIRA_IMPORT_PAGE_SIZE - so a caller-supplied small `maxRows` (the import UI uses this
  // to process in small chunks and show "x/n processed" progress between calls - backlog
  // item 9.26) genuinely bounds how many rows this one call processes, rather than always
  // finishing out whatever page it started fetching.
  while (results.length < maxRows) {
    const pageSize = Math.min(SPIRA_IMPORT_PAGE_SIZE, maxRows - results.length);
    const requirements = await client.listRequirements({ startRow, numberOfRows: pageSize });
    if (requirements.length === 0) break;

    for (const raw of requirements) {
      const mapped = applyMapping(raw, params.mapping, customFieldResolution);
      results.push(
        await importOneRequirementRow(db, params.tenantId, params.productId, params.levelId, params.createdBy, mapped, null, customFieldResolution),
      );
    }

    if (requirements.length < pageSize) break;
    startRow += pageSize;
  }

  return results;
}

/**
 * The legacy-id-preserving path (see RequirementFieldMapping.legacyId): fetches every
 * row up front (ignoring `startRow` - resuming a sorted run without refetching everything
 * would defeat the sort, and re-running from scratch is safe regardless, since each row
 * is still matched/deduplicated by Spira id the normal way), sorts by the parsed legacy
 * number ascending (rows with no parseable number sort last, keeping their relative
 * order), then creates them in that single pass. Processing in ascending order is what
 * makes this collision-free *without* needing to check or catch anything: each row's
 * `ensureSequenceCounterAtLeast` bump lands the counter exactly one below its own
 * requested number and nothing higher has been claimed yet, so the immediately-following
 * auto-increment inside createOrUpdateRequirementFromImport always lands on exactly that
 * number.
 *
 * **Works fine into a level that already has requirements in it** - re-running an import,
 * or running it alongside requirements created directly in this system. Three cases, all
 * handled without failing the row:
 * - A row already imported before (matched by Spira id via external_links, same as the
 *   non-ordered path) is **updated** in place - its existing local sequence number is
 *   never touched, whether or not its legacy id would still land there today.
 * - A genuinely new row claims its requested number if that number is free.
 * - A genuinely new row whose requested number is **already taken** - by an earlier row
 *   in this same batch, an already-imported item, or something created directly in this
 *   system - is still **added**, just with the next available number instead: the
 *   duplicate id is effectively ignored rather than blocking the row (see
 *   importOneRequirementRow's `mismatchNote`, which says so in the per-row result).
 * One honest limitation worth knowing, inherent to bumping a shared counter forward
 * rather than reserving exact slots up front: a requested number at or below the
 * counter's current position (because something already occupies that range) always
 * rolls forward rather than erroring or waiting - there's no attempt to backfill a gap
 * below the counter. */
async function runOrderedSpiraImport(
  db: AppDb,
  client: SpiraClient,
  params: RunSpiraImportParams,
): Promise<ImportRowResult[]> {
  const customFieldResolution = await loadCustomFieldMappingResolution(
    db,
    params.tenantId,
    "requirement",
    params.mapping.customFields,
  );

  const maxRows = params.maxRows ?? SPIRA_IMPORT_MAX_ROWS_DEFAULT;
  const fetched: MappedRequirement[] = [];
  let startRow = 1;
  while (fetched.length < maxRows) {
    const page = await client.listRequirements({ startRow, numberOfRows: SPIRA_IMPORT_PAGE_SIZE });
    if (page.length === 0) break;
    fetched.push(...page.map((raw) => applyMapping(raw, params.mapping, customFieldResolution)));
    if (page.length < SPIRA_IMPORT_PAGE_SIZE) break;
    startRow += SPIRA_IMPORT_PAGE_SIZE;
  }
  const rows = fetched.slice(0, maxRows);

  const withNumber = rows.filter((r): r is MappedRequirement & { requestedSequenceNumber: number } => r.requestedSequenceNumber != null);
  const withoutNumber = rows.filter((r) => r.requestedSequenceNumber == null);
  withNumber.sort((a, b) => a.requestedSequenceNumber - b.requestedSequenceNumber);
  const ordered = [...withNumber, ...withoutNumber];

  const results: ImportRowResult[] = [];
  for (const mapped of ordered) {
    const claimBefore = mapped.requestedSequenceNumber != null ? mapped.requestedSequenceNumber - 1 : null;
    results.push(
      await importOneRequirementRow(db, params.tenantId, params.productId, params.levelId, params.createdBy, mapped, claimBefore, customFieldResolution),
    );
  }
  return results;
}
