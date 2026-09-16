import { type TenantTx, schema } from "@galm/db";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { writeAuditLog } from "./audit";
import { type CustomFieldValueInput, setCustomFieldValues } from "./custom-fields";
import { DomainError } from "./errors";
import {
  type ExternalSource,
  findEntityIdBySource,
  type ImportUpsertAction,
  recordExternalLink,
} from "./external-links";
import { formatItemId } from "./item-id";
import { decrementSequenceCounterIfTip, nextSequenceNumber } from "./level-sequences";
import { sanitizeRichText } from "./rich-text";
import { getTestLevel } from "./test-levels";

export type StepResultStatus = "pass" | "fail" | "blocked";

export interface TestStepInput {
  description: string;
  expectedResult: string;
  /** Plain text, not rich HTML - a short optional annotation, unlike description/
   * expectedResult. Stored trimmed as-is; never sanitized as HTML because it's never
   * rendered as HTML either. */
  purpose?: string | null;
  /** Step-level requirement links - see getEffectiveRequirementLinks: a test case is
   * "linked" to a requirement if any of its steps are, without duplicating that link
   * into test_case_requirement_links. */
  requirementIds?: string[];
  /** Set when this step came from an import - records an external_links row so a future
   * re-import can match and update this exact step instead of creating a duplicate. Both
   * must be set together (or omitted together). */
  source?: ExternalSource;
  externalId?: string;
}

export async function createTestCase(
  db: TenantTx,
  params: {
    tenantId: string;
    productId: string;
    levelId: string;
    title: string;
    /** Direct test-case-level links, independent of any step link. */
    requirementIds?: string[];
    steps: TestStepInput[];
    createdBy: string;
    /** Set when this test case came from an import - see TestStepInput.source. */
    source?: ExternalSource;
    externalId?: string;
    /** Same reasoning as createRequirement's param of the same name
     * (packages/core/src/requirements.ts) - validated (including required-ness) and
     * written in the same transaction as the test case. */
    customFieldValues?: CustomFieldValueInput[];
  },
) {
  if (params.steps.length === 0) {
    throw new DomainError("a test case needs at least one step");
  }

  const level = await getTestLevel(db, params.tenantId, params.levelId);
  const sequenceNumber = await nextSequenceNumber(db, params.tenantId, params.productId, params.levelId);

  const [testCase] = await db
    .insert(schema.testCases)
    .values({
      tenantId: params.tenantId,
      productId: params.productId,
      levelId: params.levelId,
      sequenceNumber,
      title: params.title,
      createdBy: params.createdBy,
    })
    .returning();
  if (!testCase) throw new DomainError("failed to create test case");

  await setCustomFieldValues(db, params.tenantId, "test_case", testCase.id, params.customFieldValues ?? []);

  const steps: (typeof schema.testSteps.$inferSelect)[] = [];
  for (const [index, stepInput] of params.steps.entries()) {
    const [step] = await db
      .insert(schema.testSteps)
      .values({
        tenantId: params.tenantId,
        testCaseId: testCase.id,
        stepNumber: index + 1,
        description: sanitizeRichText(stepInput.description),
        expectedResult: sanitizeRichText(stepInput.expectedResult),
        // Plain text, not rich HTML (unlike description/expectedResult) - purpose is a
        // short, optional annotation, not something worth a whole rich-text toolbar for.
        // Trimmed only; never rendered via dangerouslySetInnerHTML, so no HTML sanitizer
        // pass is needed here for it to be safe to display.
        purpose: stepInput.purpose?.trim() || null,
      })
      .returning();
    if (!step) throw new DomainError("failed to create test step");
    steps.push(step);

    if (stepInput.source && stepInput.externalId) {
      await recordExternalLink(db, {
        tenantId: params.tenantId,
        entityType: "test_step",
        entityId: step.id,
        source: stepInput.source,
        externalId: stepInput.externalId,
      });
    }

    if (stepInput.requirementIds?.length) {
      await db.insert(schema.testStepRequirementLinks).values(
        stepInput.requirementIds.map((requirementId) => ({
          tenantId: params.tenantId,
          testStepId: step.id,
          requirementId,
        })),
      );
    }
  }

  if (params.requirementIds?.length) {
    await db.insert(schema.testCaseRequirementLinks).values(
      params.requirementIds.map((requirementId) => ({
        tenantId: params.tenantId,
        testCaseId: testCase.id,
        requirementId,
      })),
    );
  }

  if (params.source && params.externalId) {
    await recordExternalLink(db, {
      tenantId: params.tenantId,
      entityType: "test_case",
      entityId: testCase.id,
      source: params.source,
      externalId: params.externalId,
    });
  }

  await writeAuditLog(db, {
    tenantId: params.tenantId,
    actorUserId: params.createdBy,
    action: "test_case.created",
    entityType: "test_case",
    entityId: testCase.id,
    // displayId stamped in for the same reason as requirement.created's audit payload
    // (see requirements.ts) - self-describing even after a later level-code rename.
    payload: {
      title: params.title,
      stepCount: steps.length,
      displayId: formatItemId(level.code, sequenceNumber),
    },
  });

  return { testCase, steps };
}

/**
 * Idempotent create-or-update for an importer (e.g. Spira): looks up whether `externalId`
 * was already imported, and if so, reconciles its steps in place rather than creating a
 * duplicate test case. Per-step matching is by each step's own `externalId` (see
 * TestStepInput.source/externalId on createTestCase) - a step present locally but no
 * longer in the source is left untouched, never deleted: `test_step_executions` references
 * `test_steps` with no cascading delete (historical executions must stay resolvable), and
 * more fundamentally, silently deleting a step nobody asked to remove isn't safe to do
 * automatically. This is the one real gap in "sync" here - a step removed at the source
 * doesn't disappear locally; a human has to remove it.
 */
export async function createOrUpdateTestCaseFromImport(
  db: TenantTx,
  params: {
    tenantId: string;
    productId: string;
    levelId: string;
    title: string;
    createdBy: string;
    source: ExternalSource;
    externalId: string;
    steps: Array<{ externalId: string; description: string; expectedResult: string; purpose?: string | null; position: number }>;
    customFieldValues?: CustomFieldValueInput[];
    /** Local requirement ids this test case should be linked to, already resolved by the
     * caller (see packages/integrations/spira/src/requirement-links.ts) - kept
     * Spira-agnostic here, same as customFieldValues above. Reconciled additively; see
     * addTestCaseRequirementLinks for why. */
    requirementIds?: string[];
  },
): Promise<{
  action: ImportUpsertAction;
  testCaseId: string;
  stepsCreated: number;
  stepsUpdated: number;
  stepsUnchanged: number;
  /** How many of `requirementIds` weren't already linked and got added - 0 doesn't mean
   * "nothing to link", it can also mean every one was already linked (e.g. unchanged on
   * re-import). */
  linksAdded: number;
  /** Only set on `action: "created"` - see createOrUpdateRequirementFromImport's
   * identical field for why (lets a legacy-id-preserving import notice when its
   * requested number didn't actually land). */
  sequenceNumber?: number;
}> {
  const existingId = await findEntityIdBySource(db, {
    tenantId: params.tenantId,
    entityType: "test_case",
    source: params.source,
    externalId: params.externalId,
  });

  if (!existingId) {
    const { testCase } = await createTestCase(db, {
      tenantId: params.tenantId,
      productId: params.productId,
      levelId: params.levelId,
      title: params.title,
      createdBy: params.createdBy,
      source: params.source,
      externalId: params.externalId,
      customFieldValues: params.customFieldValues,
      requirementIds: params.requirementIds,
      steps: params.steps.map((s) => ({
        description: s.description,
        expectedResult: s.expectedResult,
        purpose: s.purpose,
        source: params.source,
        externalId: s.externalId,
      })),
    });
    return {
      action: "created",
      testCaseId: testCase.id,
      stepsCreated: params.steps.length,
      stepsUpdated: 0,
      stepsUnchanged: 0,
      linksAdded: new Set(params.requirementIds ?? []).size,
      sequenceNumber: testCase.sequenceNumber,
    };
  }

  const [existingTestCase] = await db
    .select()
    .from(schema.testCases)
    .where(and(eq(schema.testCases.id, existingId), eq(schema.testCases.tenantId, params.tenantId)));
  if (!existingTestCase) throw new DomainError("test case not found");

  // Same reasoning as createOrUpdateRequirementFromImport - custom field values aren't
  // versioned/status-gated, so a re-import always reconciles them (cheap no-op if
  // nothing changed), independent of whether the title/steps below did. Its result feeds
  // into `changed` below - a re-import that only changed a custom field (the common case
  // right after mapping one for the first time against rows already imported before)
  // must still report "updated", not "unchanged".
  const customFieldsResult = await setCustomFieldValues(
    db,
    params.tenantId,
    "test_case",
    existingId,
    params.customFieldValues ?? [],
  );

  // Same additive-only reasoning as addTestCaseRequirementLinks' own docstring - a
  // re-import only ever adds trace coverage, never removes a link that isn't in the
  // current source payload.
  const linksResult = await addTestCaseRequirementLinks(db, params.tenantId, existingId, params.requirementIds ?? []);

  const titleChanged = existingTestCase.title !== params.title;
  if (titleChanged) {
    await db
      .update(schema.testCases)
      .set({ title: params.title, updatedAt: new Date() })
      .where(eq(schema.testCases.id, existingId));
  }

  const existingSteps = await db
    .select()
    .from(schema.testSteps)
    .where(and(eq(schema.testSteps.testCaseId, existingId), eq(schema.testSteps.tenantId, params.tenantId)));
  const stepsByEntityId = new Map(existingSteps.map((s) => [s.id, s]));

  const existingStepLinks = existingSteps.length
    ? await db
        .select({ entityId: schema.externalLinks.entityId, externalId: schema.externalLinks.externalId })
        .from(schema.externalLinks)
        .where(
          and(
            eq(schema.externalLinks.tenantId, params.tenantId),
            eq(schema.externalLinks.entityType, "test_step"),
            eq(schema.externalLinks.source, params.source),
            inArray(
              schema.externalLinks.entityId,
              existingSteps.map((s) => s.id),
            ),
          ),
        )
    : [];
  const stepIdByExternalId = new Map(existingStepLinks.map((l) => [l.externalId, l.entityId]));

  let stepsCreated = 0;
  let stepsUpdated = 0;
  let stepsUnchanged = 0;

  for (const incoming of params.steps) {
    const sanitizedDescription = sanitizeRichText(incoming.description);
    const sanitizedExpectedResult = sanitizeRichText(incoming.expectedResult);
    const sanitizedPurpose = incoming.purpose ? sanitizeRichText(incoming.purpose) : null;
    const existingStepId = stepIdByExternalId.get(incoming.externalId);
    const existingStep = existingStepId ? stepsByEntityId.get(existingStepId) : undefined;

    if (existingStep) {
      const unchanged =
        existingStep.description === sanitizedDescription &&
        existingStep.expectedResult === sanitizedExpectedResult &&
        (existingStep.purpose ?? null) === sanitizedPurpose &&
        existingStep.stepNumber === incoming.position;
      if (unchanged) {
        stepsUnchanged++;
        continue;
      }
      await db
        .update(schema.testSteps)
        .set({
          description: sanitizedDescription,
          expectedResult: sanitizedExpectedResult,
          purpose: sanitizedPurpose,
          stepNumber: incoming.position,
        })
        .where(eq(schema.testSteps.id, existingStep.id));
      stepsUpdated++;
    } else {
      const [step] = await db
        .insert(schema.testSteps)
        .values({
          tenantId: params.tenantId,
          testCaseId: existingId,
          stepNumber: incoming.position,
          description: sanitizedDescription,
          expectedResult: sanitizedExpectedResult,
          purpose: sanitizedPurpose,
        })
        .returning();
      if (!step) throw new DomainError("failed to create test step during import update");
      await recordExternalLink(db, {
        tenantId: params.tenantId,
        entityType: "test_step",
        entityId: step.id,
        source: params.source,
        externalId: incoming.externalId,
      });
      stepsCreated++;
    }
  }

  const changed = titleChanged || stepsCreated > 0 || stepsUpdated > 0 || customFieldsResult.changed || linksResult.added > 0;
  if (changed) {
    await writeAuditLog(db, {
      tenantId: params.tenantId,
      actorUserId: params.createdBy,
      action: "test_case.updated_from_import",
      entityType: "test_case",
      entityId: existingId,
      payload: { title: params.title, stepsCreated, stepsUpdated, stepsUnchanged, linksAdded: linksResult.added },
    });
  }

  return {
    action: changed ? "updated" : "unchanged",
    testCaseId: existingId,
    stepsCreated,
    stepsUpdated,
    stepsUnchanged,
    linksAdded: linksResult.added,
  };
}

export interface TestStepEditInput {
  /** Omit for a new step; set to an existing step's id to edit it in place. Reordering is
   * just resubmitting the full step list in the desired order - stepNumber is always
   * derived from array position, not passed separately. */
  id?: string;
  description: string;
  expectedResult: string;
  /** Plain text, not rich HTML - see TestStepInput.purpose's note. */
  purpose?: string | null;
  requirementIds?: string[];
}

/**
 * Full-replace update for a test case: title, custom field values, case-level requirement
 * links, and the step list (edited in place, added, removed, and/or reordered - all in one
 * call, since the UI resubmits the complete desired step list rather than sending granular
 * diffs). Custom field values are folded into this single call - unlike a requirement's
 * (which stay a separate mutation because they're not gated by version/status the way
 * title/description are, see requirements.ts's updateCustomFieldValues), a test case has no
 * versioning concept at all to keep separate from, so there's no reason to make the UI
 * submit them in two calls.
 *
 * Test cases aren't versioned/locked the way requirements are (no approval workflow - see
 * TECH_STACK.md), so there's no "can this be edited" gate here; it's always editable. The
 * one real constraint is `test_step_executions.test_step_id`, which has no cascading delete
 * and is NOT NULL - a step that has ever been executed can't be hard-deleted without
 * violating that foreign key, since historical evidence must stay resolvable to its step.
 * Editing an executed step's own text is still fine (steps were never versioned; only the
 * execution's snapshot is frozen) - only *removing* an executed step is refused, with a
 * clear error instead of a raw constraint violation surfacing to the user.
 */
export async function updateTestCase(
  db: TenantTx,
  params: {
    tenantId: string;
    testCaseId: string;
    title: string;
    requirementIds?: string[];
    steps: TestStepEditInput[];
    actorUserId: string;
    customFieldValues?: CustomFieldValueInput[];
  },
) {
  if (params.steps.length === 0) {
    throw new DomainError("a test case needs at least one step");
  }

  const [existing] = await db
    .select()
    .from(schema.testCases)
    .where(and(eq(schema.testCases.id, params.testCaseId), eq(schema.testCases.tenantId, params.tenantId)));
  if (!existing) throw new DomainError("test case not found");

  const existingSteps = await db
    .select()
    .from(schema.testSteps)
    .where(and(eq(schema.testSteps.testCaseId, params.testCaseId), eq(schema.testSteps.tenantId, params.tenantId)));
  const existingStepIds = new Set(existingSteps.map((s) => s.id));

  for (const stepInput of params.steps) {
    if (stepInput.id && !existingStepIds.has(stepInput.id)) {
      throw new DomainError("step does not belong to this test case");
    }
  }

  const incomingIds = new Set(params.steps.flatMap((s) => (s.id ? [s.id] : [])));
  const removedStepIds = existingSteps.filter((s) => !incomingIds.has(s.id)).map((s) => s.id);

  if (removedStepIds.length > 0) {
    const executedSteps = await db
      .select({ testStepId: schema.testStepExecutions.testStepId })
      .from(schema.testStepExecutions)
      .where(inArray(schema.testStepExecutions.testStepId, removedStepIds));
    if (executedSteps.length > 0) {
      throw new DomainError(
        "one or more removed steps have execution history and can't be deleted - they're kept as evidence for past runs",
      );
    }
  }

  await db
    .update(schema.testCases)
    .set({ title: params.title, updatedAt: new Date() })
    .where(eq(schema.testCases.id, params.testCaseId));

  await setCustomFieldValues(db, params.tenantId, "test_case", params.testCaseId, params.customFieldValues ?? []);

  if (removedStepIds.length > 0) {
    await db.delete(schema.testSteps).where(inArray(schema.testSteps.id, removedStepIds));
  }

  const steps: (typeof schema.testSteps.$inferSelect)[] = [];
  for (const [index, stepInput] of params.steps.entries()) {
    const sanitizedDescription = sanitizeRichText(stepInput.description);
    const sanitizedExpectedResult = sanitizeRichText(stepInput.expectedResult);
    // Plain text, not rich HTML - see createTestCase's identical note.
    const plainPurpose = stepInput.purpose?.trim() || null;

    let step: (typeof schema.testSteps.$inferSelect) | undefined;
    if (stepInput.id) {
      [step] = await db
        .update(schema.testSteps)
        .set({
          stepNumber: index + 1,
          description: sanitizedDescription,
          expectedResult: sanitizedExpectedResult,
          purpose: plainPurpose,
        })
        .where(eq(schema.testSteps.id, stepInput.id))
        .returning();
      if (!step) throw new DomainError("failed to update test step");
    } else {
      [step] = await db
        .insert(schema.testSteps)
        .values({
          tenantId: params.tenantId,
          testCaseId: params.testCaseId,
          stepNumber: index + 1,
          description: sanitizedDescription,
          expectedResult: sanitizedExpectedResult,
          purpose: plainPurpose,
        })
        .returning();
      if (!step) throw new DomainError("failed to create test step");
    }
    steps.push(step);

    // Full-replace this step's requirement links rather than diffing them - simpler, and
    // cheap at the scale a single step's link list ever reaches.
    await db.delete(schema.testStepRequirementLinks).where(eq(schema.testStepRequirementLinks.testStepId, step.id));
    if (stepInput.requirementIds?.length) {
      await db.insert(schema.testStepRequirementLinks).values(
        stepInput.requirementIds.map((requirementId) => ({
          tenantId: params.tenantId,
          testStepId: step!.id,
          requirementId,
        })),
      );
    }
  }

  await db.delete(schema.testCaseRequirementLinks).where(eq(schema.testCaseRequirementLinks.testCaseId, params.testCaseId));
  if (params.requirementIds?.length) {
    await db.insert(schema.testCaseRequirementLinks).values(
      params.requirementIds.map((requirementId) => ({
        tenantId: params.tenantId,
        testCaseId: params.testCaseId,
        requirementId,
      })),
    );
  }

  await writeAuditLog(db, {
    tenantId: params.tenantId,
    actorUserId: params.actorUserId,
    action: "test_case.updated",
    entityType: "test_case",
    entityId: params.testCaseId,
    payload: { title: params.title, stepCount: steps.length },
  });

  return { testCase: { ...existing, title: params.title }, steps };
}

/** Adds any of `requirementIds` this test case isn't already linked to - additive only,
 * never removes an existing link. Same "don't delete something nobody asked to remove"
 * policy createOrUpdateTestCaseFromImport already applies to steps (a step missing from
 * the current source payload is left alone, never deleted): a link added by hand in this
 * system, or by an earlier import, stays even if the *current* Spira payload doesn't
 * mention it - re-running an import should only ever add trace coverage, never quietly
 * remove some a person set up directly here. Used by the Spira test case importer
 * (backlog item 9.26) to reconcile requirement trace links on both create and re-import;
 * `createTestCase`'s own `requirementIds` param already covers the create path. */
export async function addTestCaseRequirementLinks(
  db: TenantTx,
  tenantId: string,
  testCaseId: string,
  requirementIds: string[],
): Promise<{ added: number }> {
  if (requirementIds.length === 0) return { added: 0 };
  const existing = await db
    .select({ requirementId: schema.testCaseRequirementLinks.requirementId })
    .from(schema.testCaseRequirementLinks)
    .where(and(eq(schema.testCaseRequirementLinks.testCaseId, testCaseId), eq(schema.testCaseRequirementLinks.tenantId, tenantId)));
  const existingIds = new Set(existing.map((e) => e.requirementId));
  const missing = [...new Set(requirementIds)].filter((id) => !existingIds.has(id));
  if (missing.length === 0) return { added: 0 };

  await db
    .insert(schema.testCaseRequirementLinks)
    .values(missing.map((requirementId) => ({ tenantId, testCaseId, requirementId })))
    .onConflictDoNothing();
  return { added: missing.length };
}

/**
 * Hard delete (backlog item 9.27) - test cases have no versioning/approval workflow the
 * way requirements do (see updateTestCase's docstring: "always editable"), so the only
 * guard is the one this codebase already applies to a single executed *step*
 * (TestStepEditInput's docstring: "a step that has ever been executed can't be
 * hard-deleted... historical evidence must stay resolvable"), extended to the whole test
 * case: **refused while it has any execution history at all**. `test_executions.test_case_id`
 * is a real cascading FK, so the database itself would happily let this silently wipe out
 * real evidence of what was actually run and when - this check is what actually protects
 * that, the same "count and refuse" shape as deleteEnvironment (test-environments.ts).
 *
 * `test_steps`, `test_case_requirement_links`, and `test_step_requirement_links` all
 * cascade away with the row. `external_links` and `custom_field_values` don't (both
 * deliberately polymorphic, not foreign-keyed - see deleteRequirement's identical note in
 * requirements.ts) so they're cleaned up explicitly, for the test case itself and for
 * each of its steps (steps get their own `external_links` row when imported - see
 * createTestCase). `audit_log` is left alone on purpose, same reasoning as
 * deleteRequirement.
 */
export async function deleteTestCase(db: TenantTx, tenantId: string, testCaseId: string, actorUserId: string) {
  const { testCase, steps } = await getTestCaseWithSteps(db, tenantId, testCaseId);

  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.testExecutions)
    .where(and(eq(schema.testExecutions.testCaseId, testCaseId), eq(schema.testExecutions.tenantId, tenantId)));
  const executionCount = row?.count ?? 0;
  if (executionCount > 0) {
    throw new DomainError(
      `cannot delete a test case that has ${executionCount} execution${executionCount === 1 ? "" : "s"} - historical evidence must stay resolvable`,
    );
  }

  const level = await getTestLevel(db, tenantId, testCase.levelId);
  const displayId = formatItemId(level.code, testCase.sequenceNumber);

  await db
    .delete(schema.externalLinks)
    .where(
      and(
        eq(schema.externalLinks.tenantId, tenantId),
        eq(schema.externalLinks.entityType, "test_case"),
        eq(schema.externalLinks.entityId, testCaseId),
      ),
    );
  if (steps.length > 0) {
    await db
      .delete(schema.externalLinks)
      .where(
        and(
          eq(schema.externalLinks.tenantId, tenantId),
          eq(schema.externalLinks.entityType, "test_step"),
          inArray(
            schema.externalLinks.entityId,
            steps.map((s) => s.id),
          ),
        ),
      );
  }
  await db.delete(schema.customFieldValues).where(eq(schema.customFieldValues.entityId, testCaseId));

  await db.delete(schema.testCases).where(and(eq(schema.testCases.id, testCaseId), eq(schema.testCases.tenantId, tenantId)));

  // See deleteRequirement's identical note (requirements.ts) / decrementSequenceCounterIfTip's
  // docstring (level-sequences.ts) - only reclaims the number if this was still the
  // highest one ever handed out for this (product, level).
  const reclaimed = await decrementSequenceCounterIfTip(db, tenantId, testCase.productId, testCase.levelId, testCase.sequenceNumber);

  await writeAuditLog(db, {
    tenantId,
    actorUserId,
    action: "test_case.deleted",
    entityType: "test_case",
    entityId: testCaseId,
    payload: { displayId, title: testCase.title, numberReclaimed: reclaimed },
  });
}

export async function getTestCaseWithSteps(db: TenantTx, tenantId: string, testCaseId: string) {
  const [testCase] = await db
    .select()
    .from(schema.testCases)
    .where(and(eq(schema.testCases.id, testCaseId), eq(schema.testCases.tenantId, tenantId)));
  if (!testCase) throw new DomainError("test case not found");

  const steps = await db
    .select()
    .from(schema.testSteps)
    .where(eq(schema.testSteps.testCaseId, testCaseId))
    .orderBy(asc(schema.testSteps.stepNumber));

  return { testCase, steps };
}

/** "If a step is linked, the test case automatically is" - computed at read time as the
 * union of direct test_case_requirement_links and every linked step's requirements,
 * rather than duplicating step links into the test-case table at write time. */
export async function getEffectiveRequirementLinks(db: TenantTx, tenantId: string, testCaseId: string) {
  const direct = await db
    .select({ requirementId: schema.testCaseRequirementLinks.requirementId })
    .from(schema.testCaseRequirementLinks)
    .where(
      and(
        eq(schema.testCaseRequirementLinks.testCaseId, testCaseId),
        eq(schema.testCaseRequirementLinks.tenantId, tenantId),
      ),
    );

  const viaSteps = await db
    .select({ requirementId: schema.testStepRequirementLinks.requirementId })
    .from(schema.testStepRequirementLinks)
    .innerJoin(schema.testSteps, eq(schema.testStepRequirementLinks.testStepId, schema.testSteps.id))
    .where(and(eq(schema.testSteps.testCaseId, testCaseId), eq(schema.testStepRequirementLinks.tenantId, tenantId)));

  const ids = [...new Set([...direct.map((d) => d.requirementId), ...viaSteps.map((v) => v.requirementId)])];
  if (ids.length === 0) return [];

  return db
    .select({
      id: schema.requirements.id,
      sequenceNumber: schema.requirements.sequenceNumber,
      title: schema.requirementVersions.title,
      levelCode: schema.levels.code,
    })
    .from(schema.requirements)
    .innerJoin(schema.requirementVersions, eq(schema.requirements.currentVersionId, schema.requirementVersions.id))
    .innerJoin(schema.levels, eq(schema.requirements.levelId, schema.levels.id))
    .where(inArray(schema.requirements.id, ids));
}

/** The inverse of getEffectiveRequirementLinks: given a requirement, which test cases
 * cover it (directly, or because one of their steps links to it)? Backs the requirement
 * detail page's "Covered by" section and the traceability matrix. */
export async function getCoveringTestCases(db: TenantTx, tenantId: string, requirementId: string) {
  const direct = await db
    .select({ testCaseId: schema.testCaseRequirementLinks.testCaseId })
    .from(schema.testCaseRequirementLinks)
    .where(
      and(
        eq(schema.testCaseRequirementLinks.requirementId, requirementId),
        eq(schema.testCaseRequirementLinks.tenantId, tenantId),
      ),
    );

  const viaSteps = await db
    .select({ testCaseId: schema.testSteps.testCaseId })
    .from(schema.testStepRequirementLinks)
    .innerJoin(schema.testSteps, eq(schema.testStepRequirementLinks.testStepId, schema.testSteps.id))
    .where(and(eq(schema.testStepRequirementLinks.requirementId, requirementId), eq(schema.testStepRequirementLinks.tenantId, tenantId)));

  const ids = [...new Set([...direct.map((d) => d.testCaseId), ...viaSteps.map((v) => v.testCaseId)])];
  if (ids.length === 0) return [];

  return db
    .select({
      id: schema.testCases.id,
      sequenceNumber: schema.testCases.sequenceNumber,
      title: schema.testCases.title,
      levelCode: schema.levels.code,
    })
    .from(schema.testCases)
    .innerJoin(schema.levels, eq(schema.testCases.levelId, schema.levels.id))
    .where(inArray(schema.testCases.id, ids));
}

export async function startExecution(
  db: TenantTx,
  params: { tenantId: string; testCaseId: string; environmentId: string; executedBy: string },
) {
  const steps = await db
    .select()
    .from(schema.testSteps)
    .where(and(eq(schema.testSteps.testCaseId, params.testCaseId), eq(schema.testSteps.tenantId, params.tenantId)))
    .orderBy(asc(schema.testSteps.stepNumber));
  if (steps.length === 0) throw new DomainError("test case has no steps to execute");

  const [execution] = await db
    .insert(schema.testExecutions)
    .values({
      tenantId: params.tenantId,
      testCaseId: params.testCaseId,
      environmentId: params.environmentId,
      executedBy: params.executedBy,
    })
    .returning();
  if (!execution) throw new DomainError("failed to start execution");

  const stepExecutions: (typeof schema.testStepExecutions.$inferSelect)[] = [];
  for (const step of steps) {
    // Snapshotted here, not just referenced by id - test_steps isn't versioned, so this
    // is what keeps a historical execution accurate if the step is edited later.
    const [stepExecution] = await db
      .insert(schema.testStepExecutions)
      .values({
        tenantId: params.tenantId,
        testExecutionId: execution.id,
        testStepId: step.id,
        stepNumber: step.stepNumber,
        descriptionSnapshot: step.description,
        expectedResultSnapshot: step.expectedResult,
      })
      .returning();
    if (!stepExecution) throw new DomainError("failed to create step execution");
    stepExecutions.push(stepExecution);
  }

  await writeAuditLog(db, {
    tenantId: params.tenantId,
    actorUserId: params.executedBy,
    action: "test_execution.started",
    entityType: "test_execution",
    entityId: execution.id,
    payload: { testCaseId: params.testCaseId, stepCount: steps.length },
  });

  return { execution, stepExecutions };
}

export async function getExecutionWithSteps(db: TenantTx, tenantId: string, testExecutionId: string) {
  const [execution] = await db
    .select()
    .from(schema.testExecutions)
    .where(and(eq(schema.testExecutions.id, testExecutionId), eq(schema.testExecutions.tenantId, tenantId)));
  if (!execution) throw new DomainError("execution not found");

  const stepExecutions = await db
    .select()
    .from(schema.testStepExecutions)
    .where(eq(schema.testStepExecutions.testExecutionId, testExecutionId))
    .orderBy(asc(schema.testStepExecutions.stepNumber));

  return { execution, stepExecutions };
}

export async function recordStepResult(
  db: TenantTx,
  params: {
    tenantId: string;
    testStepExecutionId: string;
    actualResult: string;
    status: StepResultStatus;
  },
) {
  const [updated] = await db
    .update(schema.testStepExecutions)
    .set({
      actualResult: sanitizeRichText(params.actualResult),
      status: params.status,
      recordedAt: new Date(),
    })
    .where(
      and(
        eq(schema.testStepExecutions.id, params.testStepExecutionId),
        eq(schema.testStepExecutions.tenantId, params.tenantId),
      ),
    )
    .returning();
  if (!updated) throw new DomainError("step execution not found");
  return updated;
}

/** Refuses to complete while any step is still `not_run` - a run isn't "done" with
 * pending steps. Overall status is a rollup, not independently settable: fail beats
 * blocked beats pass. */
export async function completeExecution(db: TenantTx, tenantId: string, testExecutionId: string, actorUserId: string) {
  const [execution] = await db
    .select()
    .from(schema.testExecutions)
    .where(and(eq(schema.testExecutions.id, testExecutionId), eq(schema.testExecutions.tenantId, tenantId)));
  if (!execution) throw new DomainError("execution not found");
  if (execution.completedAt) throw new DomainError("execution is already completed");

  const stepExecutions = await db
    .select()
    .from(schema.testStepExecutions)
    .where(eq(schema.testStepExecutions.testExecutionId, testExecutionId));

  if (stepExecutions.some((se) => se.status === "not_run")) {
    throw new DomainError("all steps must be recorded before completing the execution");
  }

  let overall: StepResultStatus = "pass";
  if (stepExecutions.some((se) => se.status === "fail")) overall = "fail";
  else if (stepExecutions.some((se) => se.status === "blocked")) overall = "blocked";

  const [updated] = await db
    .update(schema.testExecutions)
    .set({ status: overall, completedAt: new Date() })
    .where(eq(schema.testExecutions.id, testExecutionId))
    .returning();
  if (!updated) throw new DomainError("failed to complete execution");

  await writeAuditLog(db, {
    tenantId,
    actorUserId,
    action: "test_execution.completed",
    entityType: "test_execution",
    entityId: testExecutionId,
    payload: { status: overall },
  });

  return updated;
}
