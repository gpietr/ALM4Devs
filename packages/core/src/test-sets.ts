import { type TenantTx, schema } from "@galm/db";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { writeAuditLog } from "./audit";
import { type CustomFieldValueInput, type CustomFieldValueView, getCustomFieldValuesForEntities, setCustomFieldValues } from "./custom-fields";
import { DomainError } from "./errors";

/**
 * Test sets: a named, ordered, reusable subset of tests to run. Product-scoped like every
 * other artifact. See schema.ts's testSets/testSetItems docstrings for why an item's `id`
 * is its own primary key (the same test case can be placed in a set more than once, e.g.
 * once per environment) and why custom parameters beyond environment reuse the existing
 * tenant-defined custom-fields system under `entityType: "test_run"` rather than a new
 * table. A run started from an item (test-cases.ts's startExecution, given that item's id)
 * is traced back here via test_executions.testSetItemId - getTestSet surfaces each item's
 * most recent one, all-time, as `lastExecution` (getLastExecutionsForItems below), the
 * same "batched, first-seen-per-key wins" pattern traceability.ts's lastExecutionByTestCase
 * already uses, just keyed by item id.
 *
 * Rounds (schema.ts's testSetRounds docstring) are the optional answer to "we run this
 * same set before every release - how do we not blend releases together": starting one
 * tags every run made while it's selected with its id, and getTestSetRound reuses the
 * exact same batched-last-execution logic but scoped to that one round, so an item not yet
 * run *this round* shows `lastExecution: null` even with all-time history from a previous
 * one. A set that never starts a round is completely unaffected - getTestSet's behavior is
 * unchanged.
 */

export interface TestSetView {
  id: string;
  productId: string;
  name: string;
  description: string | null;
  createdAt: Date;
}

export interface TestSetSummary extends TestSetView {
  itemCount: number;
}

export interface TestSetItemLastExecution {
  id: string;
  status: string;
  startedAt: Date;
  completedAt: Date | null;
  executedByName: string;
}

export interface TestSetItemView {
  id: string;
  sortOrder: number;
  testCaseId: string;
  testCaseTitle: string;
  testCaseSequenceNumber: number;
  testCaseLevelCode: string;
  environmentId: string | null;
  environmentName: string | null;
  customFieldValues: CustomFieldValueView[];
  lastExecution: TestSetItemLastExecution | null;
}

export interface TestSetRoundView {
  id: string;
  testSetId: string;
  label: string | null;
  startedByName: string;
  startedAt: Date;
}

export interface TestSetRoundSummary extends TestSetRoundView {
  /** The set's *current* item count, not a snapshot of how many items existed when this
   * round ran - items can be added/removed from a set after a round happened, and there's
   * no membership history to reconstruct that from. A simplification worth surfacing, not
   * hiding. */
  itemCount: number;
  notRunCount: number;
  inProgressCount: number;
  passCount: number;
  failCount: number;
  blockedCount: number;
}

const TEST_SET_COLUMNS = {
  id: schema.testSets.id,
  productId: schema.testSets.productId,
  name: schema.testSets.name,
  description: schema.testSets.description,
  createdAt: schema.testSets.createdAt,
};

export async function createTestSet(
  db: TenantTx,
  params: { tenantId: string; productId: string; name: string; description?: string; createdBy: string },
): Promise<TestSetView> {
  const name = params.name.trim();
  if (!name) throw new DomainError("name is required");

  const [row] = await db
    .insert(schema.testSets)
    .values({
      tenantId: params.tenantId,
      productId: params.productId,
      name,
      description: params.description?.trim() || null,
      createdBy: params.createdBy,
    })
    .returning(TEST_SET_COLUMNS);
  if (!row) throw new DomainError("failed to create test set");

  await writeAuditLog(db, {
    tenantId: params.tenantId,
    actorUserId: params.createdBy,
    action: "test_set.created",
    entityType: "test_set",
    entityId: row.id,
    payload: { name },
  });
  return row;
}

export async function listTestSets(db: TenantTx, tenantId: string, productId: string): Promise<TestSetSummary[]> {
  const sets = await db
    .select(TEST_SET_COLUMNS)
    .from(schema.testSets)
    .where(and(eq(schema.testSets.tenantId, tenantId), eq(schema.testSets.productId, productId)))
    .orderBy(desc(schema.testSets.createdAt));
  if (sets.length === 0) return [];

  // One batched count per set, not N+1.
  const ids = sets.map((s) => s.id);
  const counts = await db
    .select({ testSetId: schema.testSetItems.testSetId, count: sql<number>`count(*)::int` })
    .from(schema.testSetItems)
    .where(and(eq(schema.testSetItems.tenantId, tenantId), inArray(schema.testSetItems.testSetId, ids)))
    .groupBy(schema.testSetItems.testSetId);
  const countBySet = new Map(counts.map((c) => [c.testSetId, c.count]));

  return sets.map((s) => ({ ...s, itemCount: countBySet.get(s.id) ?? 0 }));
}

async function getTestSetItemRows(db: TenantTx, tenantId: string, testSetId: string) {
  return db
    .select({
      id: schema.testSetItems.id,
      sortOrder: schema.testSetItems.sortOrder,
      testCaseId: schema.testCases.id,
      testCaseTitle: schema.testCases.title,
      testCaseSequenceNumber: schema.testCases.sequenceNumber,
      testCaseLevelCode: schema.levels.code,
      environmentId: schema.testSetItems.environmentId,
      environmentName: schema.testEnvironments.name,
    })
    .from(schema.testSetItems)
    .innerJoin(schema.testCases, eq(schema.testSetItems.testCaseId, schema.testCases.id))
    .innerJoin(schema.levels, eq(schema.testCases.levelId, schema.levels.id))
    .leftJoin(schema.testEnvironments, eq(schema.testSetItems.environmentId, schema.testEnvironments.id))
    .where(and(eq(schema.testSetItems.tenantId, tenantId), eq(schema.testSetItems.testSetId, testSetId)))
    .orderBy(asc(schema.testSetItems.sortOrder));
}

/** Batched "most recent execution per item" - all-time when `opts.roundId` is omitted
 * (getTestSet's behavior), or scoped to one round when given (getTestSetRound's). Same
 * "ordered newest-first, first one seen per key wins" pattern traceability.ts's
 * lastExecutionByTestCase already uses. */
async function getLastExecutionsForItems(
  db: TenantTx,
  tenantId: string,
  itemIds: string[],
  opts?: { roundId?: string },
): Promise<Map<string, TestSetItemLastExecution>> {
  if (itemIds.length === 0) return new Map();

  const conditions = [eq(schema.testExecutions.tenantId, tenantId), inArray(schema.testExecutions.testSetItemId, itemIds)];
  if (opts?.roundId) conditions.push(eq(schema.testExecutions.testSetRoundId, opts.roundId));

  const executions = await db
    .select({
      id: schema.testExecutions.id,
      testSetItemId: schema.testExecutions.testSetItemId,
      status: schema.testExecutions.status,
      startedAt: schema.testExecutions.startedAt,
      completedAt: schema.testExecutions.completedAt,
      executedByName: schema.user.name,
    })
    .from(schema.testExecutions)
    .innerJoin(schema.user, eq(schema.testExecutions.executedBy, schema.user.id))
    .where(and(...conditions))
    .orderBy(desc(schema.testExecutions.startedAt));

  const lastByItem = new Map<string, TestSetItemLastExecution>();
  for (const ex of executions) {
    if (ex.testSetItemId && !lastByItem.has(ex.testSetItemId)) {
      lastByItem.set(ex.testSetItemId, {
        id: ex.id,
        status: ex.status,
        startedAt: ex.startedAt,
        completedAt: ex.completedAt,
        executedByName: ex.executedByName,
      });
    }
  }
  return lastByItem;
}

async function buildItemViews(
  db: TenantTx,
  tenantId: string,
  itemRows: Awaited<ReturnType<typeof getTestSetItemRows>>,
  opts?: { roundId?: string },
): Promise<TestSetItemView[]> {
  const itemIds = itemRows.map((r) => r.id);
  const [customFieldsByItem, lastExecutionByItem] = await Promise.all([
    getCustomFieldValuesForEntities(db, tenantId, "test_run", itemIds),
    getLastExecutionsForItems(db, tenantId, itemIds, opts),
  ]);
  return itemRows.map((r) => ({
    ...r,
    environmentName: r.environmentName ?? null,
    customFieldValues: customFieldsByItem.get(r.id) ?? [],
    lastExecution: lastExecutionByItem.get(r.id) ?? null,
  }));
}

export async function getTestSet(
  db: TenantTx,
  tenantId: string,
  id: string,
): Promise<{ set: TestSetView; items: TestSetItemView[] }> {
  const [set] = await db
    .select(TEST_SET_COLUMNS)
    .from(schema.testSets)
    .where(and(eq(schema.testSets.id, id), eq(schema.testSets.tenantId, tenantId)));
  if (!set) throw new DomainError("test set not found");

  const itemRows = await getTestSetItemRows(db, tenantId, id);
  const items = await buildItemViews(db, tenantId, itemRows);
  return { set, items };
}

/** Starts a new round - "one pass through this set" (e.g. "Release 1.2") - so runs made
 * while it's selected can be told apart from a different pass made last week. Purely
 * additive: a set that never calls this behaves exactly as before (see getTestSet). */
export async function createTestSetRound(
  db: TenantTx,
  params: { tenantId: string; testSetId: string; label?: string; startedBy: string },
): Promise<TestSetRoundView> {
  const [set] = await db
    .select({ id: schema.testSets.id })
    .from(schema.testSets)
    .where(and(eq(schema.testSets.id, params.testSetId), eq(schema.testSets.tenantId, params.tenantId)));
  if (!set) throw new DomainError("test set not found");

  const [row] = await db
    .insert(schema.testSetRounds)
    .values({
      tenantId: params.tenantId,
      testSetId: params.testSetId,
      label: params.label?.trim() || null,
      startedBy: params.startedBy,
    })
    .returning();
  if (!row) throw new DomainError("failed to start test set round");

  await writeAuditLog(db, {
    tenantId: params.tenantId,
    actorUserId: params.startedBy,
    action: "test_set_round.started",
    entityType: "test_set_round",
    entityId: row.id,
    payload: { testSetId: params.testSetId, label: row.label },
  });

  const [startedByUser] = await db
    .select({ name: schema.user.name })
    .from(schema.user)
    .where(eq(schema.user.id, params.startedBy));
  return {
    id: row.id,
    testSetId: row.testSetId,
    label: row.label,
    startedAt: row.startedAt,
    startedByName: startedByUser?.name ?? "",
  };
}

export async function listTestSetRounds(db: TenantTx, tenantId: string, testSetId: string): Promise<TestSetRoundSummary[]> {
  const rounds = await db
    .select({
      id: schema.testSetRounds.id,
      testSetId: schema.testSetRounds.testSetId,
      label: schema.testSetRounds.label,
      startedAt: schema.testSetRounds.startedAt,
      startedByName: schema.user.name,
    })
    .from(schema.testSetRounds)
    .innerJoin(schema.user, eq(schema.testSetRounds.startedBy, schema.user.id))
    .where(and(eq(schema.testSetRounds.tenantId, tenantId), eq(schema.testSetRounds.testSetId, testSetId)))
    .orderBy(desc(schema.testSetRounds.startedAt));
  if (rounds.length === 0) return [];

  const [{ count: itemCount } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.testSetItems)
    .where(and(eq(schema.testSetItems.tenantId, tenantId), eq(schema.testSetItems.testSetId, testSetId)));

  // One batched query covering every round's executions, not N+1 - reduced below to
  // "latest status per (round, item)", the same "latest wins" rule a single round's own
  // getTestSetRound applies, just done for every round in the list at once.
  const roundIds = rounds.map((r) => r.id);
  const rows = await db
    .select({
      testSetRoundId: schema.testExecutions.testSetRoundId,
      testSetItemId: schema.testExecutions.testSetItemId,
      status: schema.testExecutions.status,
    })
    .from(schema.testExecutions)
    .where(and(eq(schema.testExecutions.tenantId, tenantId), inArray(schema.testExecutions.testSetRoundId, roundIds)))
    .orderBy(desc(schema.testExecutions.startedAt));

  const statusByRoundItem = new Map<string, Map<string, string>>();
  for (const row of rows) {
    // A removed item's executions keep their round tag but lose testSetItemId (set null
    // on delete) - excluded here the same way they're excluded from itemCount above.
    if (!row.testSetRoundId || !row.testSetItemId) continue;
    let byItem = statusByRoundItem.get(row.testSetRoundId);
    if (!byItem) {
      byItem = new Map();
      statusByRoundItem.set(row.testSetRoundId, byItem);
    }
    if (!byItem.has(row.testSetItemId)) byItem.set(row.testSetItemId, row.status);
  }

  return rounds.map((r) => {
    const statuses = [...(statusByRoundItem.get(r.id)?.values() ?? [])];
    return {
      ...r,
      itemCount,
      notRunCount: Math.max(itemCount - statuses.length, 0),
      inProgressCount: statuses.filter((s) => s === "in_progress").length,
      passCount: statuses.filter((s) => s === "pass").length,
      failCount: statuses.filter((s) => s === "fail").length,
      blockedCount: statuses.filter((s) => s === "blocked").length,
    };
  });
}

/** Same shape as getTestSet, but each item's `lastExecution` is scoped to this one round
 * - an item not yet run in this round shows `null` even if it has all-time history from a
 * previous one (see getLastExecutionsForItems's `roundId` option). */
export async function getTestSetRound(
  db: TenantTx,
  tenantId: string,
  roundId: string,
): Promise<{ round: TestSetRoundView; set: TestSetView; items: TestSetItemView[] }> {
  const [round] = await db
    .select({
      id: schema.testSetRounds.id,
      testSetId: schema.testSetRounds.testSetId,
      label: schema.testSetRounds.label,
      startedAt: schema.testSetRounds.startedAt,
      startedByName: schema.user.name,
    })
    .from(schema.testSetRounds)
    .innerJoin(schema.user, eq(schema.testSetRounds.startedBy, schema.user.id))
    .where(and(eq(schema.testSetRounds.id, roundId), eq(schema.testSetRounds.tenantId, tenantId)));
  if (!round) throw new DomainError("test set round not found");

  const [set] = await db
    .select(TEST_SET_COLUMNS)
    .from(schema.testSets)
    .where(and(eq(schema.testSets.id, round.testSetId), eq(schema.testSets.tenantId, tenantId)));
  if (!set) throw new DomainError("test set not found");

  const itemRows = await getTestSetItemRows(db, tenantId, round.testSetId);
  const items = await buildItemViews(db, tenantId, itemRows, { roundId });
  return { round, set, items };
}

export async function updateTestSet(
  db: TenantTx,
  params: { tenantId: string; id: string; name: string; description?: string },
): Promise<TestSetView> {
  const name = params.name.trim();
  if (!name) throw new DomainError("name is required");

  const [row] = await db
    .update(schema.testSets)
    .set({ name, description: params.description?.trim() || null })
    .where(and(eq(schema.testSets.id, params.id), eq(schema.testSets.tenantId, params.tenantId)))
    .returning(TEST_SET_COLUMNS);
  if (!row) throw new DomainError("test set not found");
  return row;
}

export async function deleteTestSet(db: TenantTx, tenantId: string, id: string): Promise<void> {
  const [row] = await db
    .delete(schema.testSets)
    .where(and(eq(schema.testSets.id, id), eq(schema.testSets.tenantId, tenantId)))
    .returning({ id: schema.testSets.id });
  if (!row) throw new DomainError("test set not found");
}

/** Appends at the end (`max(sortOrder) + 1`) - re-adding the same test case (e.g. to run
 * it under a second environment) is expected, not an error. Rejects a test case from a
 * different product than the set, same "can't link across products" invariant as
 * assertSameProductArchitectureNodes/assertSameProductSoftwareVersions. */
export async function addTestSetItem(
  db: TenantTx,
  params: {
    tenantId: string;
    testSetId: string;
    testCaseId: string;
    environmentId?: string;
    customFieldValues?: CustomFieldValueInput[];
    createdBy: string;
  },
): Promise<{ id: string }> {
  const [set] = await db
    .select({ id: schema.testSets.id, productId: schema.testSets.productId })
    .from(schema.testSets)
    .where(and(eq(schema.testSets.id, params.testSetId), eq(schema.testSets.tenantId, params.tenantId)));
  if (!set) throw new DomainError("test set not found");

  const [testCase] = await db
    .select({ id: schema.testCases.id, productId: schema.testCases.productId })
    .from(schema.testCases)
    .where(and(eq(schema.testCases.id, params.testCaseId), eq(schema.testCases.tenantId, params.tenantId)));
  if (!testCase) throw new DomainError("test case not found");
  if (testCase.productId !== set.productId) {
    throw new DomainError("a test set can only contain test cases from its own product");
  }

  const existing = await db
    .select({ sortOrder: schema.testSetItems.sortOrder })
    .from(schema.testSetItems)
    .where(and(eq(schema.testSetItems.tenantId, params.tenantId), eq(schema.testSetItems.testSetId, params.testSetId)));
  const nextSortOrder = existing.length > 0 ? Math.max(...existing.map((e) => e.sortOrder)) + 1 : 0;

  const [item] = await db
    .insert(schema.testSetItems)
    .values({
      tenantId: params.tenantId,
      testSetId: params.testSetId,
      testCaseId: params.testCaseId,
      environmentId: params.environmentId ?? null,
      sortOrder: nextSortOrder,
      createdBy: params.createdBy,
    })
    .returning({ id: schema.testSetItems.id });
  if (!item) throw new DomainError("failed to add test to test set");

  await setCustomFieldValues(db, params.tenantId, "test_run", item.id, params.customFieldValues ?? []);
  return item;
}

/** Changes an existing entry's environment and/or custom parameters in place - not a
 * remove-then-re-add, which would lose its position (`sortOrder`). `environmentId: null`
 * clears it back to "no environment tagged"; `undefined` leaves it untouched. */
export async function updateTestSetItem(
  db: TenantTx,
  params: {
    tenantId: string;
    itemId: string;
    environmentId?: string | null;
    customFieldValues?: CustomFieldValueInput[];
  },
): Promise<{ id: string }> {
  let item: { id: string } | undefined;
  if (params.environmentId !== undefined) {
    [item] = await db
      .update(schema.testSetItems)
      .set({ environmentId: params.environmentId })
      .where(and(eq(schema.testSetItems.id, params.itemId), eq(schema.testSetItems.tenantId, params.tenantId)))
      .returning({ id: schema.testSetItems.id });
  } else {
    [item] = await db
      .select({ id: schema.testSetItems.id })
      .from(schema.testSetItems)
      .where(and(eq(schema.testSetItems.id, params.itemId), eq(schema.testSetItems.tenantId, params.tenantId)));
  }
  if (!item) throw new DomainError("test set item not found");

  if (params.customFieldValues !== undefined) {
    await setCustomFieldValues(db, params.tenantId, "test_run", item.id, params.customFieldValues);
  }
  return item;
}

export async function removeTestSetItem(db: TenantTx, tenantId: string, itemId: string): Promise<void> {
  const [row] = await db
    .delete(schema.testSetItems)
    .where(and(eq(schema.testSetItems.id, itemId), eq(schema.testSetItems.tenantId, tenantId)))
    .returning({ id: schema.testSetItems.id });
  if (!row) throw new DomainError("test set item not found");
}

/** Same swap-two-sortOrders shape as reorderCustomFieldDefinition (custom-fields.ts). */
export async function reorderTestSetItem(
  db: TenantTx,
  tenantId: string,
  testSetId: string,
  itemId: string,
  direction: "up" | "down",
): Promise<void> {
  const all = await db
    .select({ id: schema.testSetItems.id, sortOrder: schema.testSetItems.sortOrder })
    .from(schema.testSetItems)
    .where(and(eq(schema.testSetItems.tenantId, tenantId), eq(schema.testSetItems.testSetId, testSetId)))
    .orderBy(asc(schema.testSetItems.sortOrder));
  const index = all.findIndex((i) => i.id === itemId);
  if (index === -1) throw new DomainError("test set item not found");
  const swapIndex = direction === "up" ? index - 1 : index + 1;
  if (swapIndex < 0 || swapIndex >= all.length) return;

  const current = all[index]!;
  const other = all[swapIndex]!;
  await db.update(schema.testSetItems).set({ sortOrder: other.sortOrder }).where(eq(schema.testSetItems.id, current.id));
  await db.update(schema.testSetItems).set({ sortOrder: current.sortOrder }).where(eq(schema.testSetItems.id, other.id));
}
