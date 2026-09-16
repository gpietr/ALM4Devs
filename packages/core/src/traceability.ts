import { type TenantTx, schema } from "@galm/db";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { type CustomFieldValueView, getCustomFieldValuesForEntities } from "./custom-fields";

export interface TraceabilityRow {
  requirementId: string;
  requirementTitle: string;
  requirementSequenceNumber: number;
  levelName: string;
  levelCode: string;
  testCaseId: string | null;
  testCaseTitle: string | null;
  testCaseSequenceNumber: number | null;
  testCaseLevelCode: string | null;
  lastExecutionStatus: string | null;
  lastExecutionStartedAt: Date | null;
  lastExecutionEnvironmentName: string | null;
  /** For the matrix's optional custom-field columns (see the column picker on the
   * traceability tab) - the requirement's own values, and (when this row does have a
   * covering test case) that test case's. Empty, not null, when there's no covering test
   * case - there's simply nothing to show in those columns for this row, same as every
   * other test-case-side column already being null here. */
  requirementCustomFieldValues: CustomFieldValueView[];
  testCaseCustomFieldValues: CustomFieldValueView[];
}

/**
 * The product-wide traceability matrix: one row per (requirement, covering test case)
 * pair, augmented with that test case's most recent execution. A requirement with no
 * covering test case still gets one row with the test-case/execution columns null - the
 * whole point of a traceability matrix for a QMS is to make coverage *gaps* visible, not
 * just confirm coverage that already exists.
 *
 * Composed from several simple queries and joined in application code, deliberately not
 * one large SQL join (a LATERAL join per test case for "most recent execution", unioned
 * with two different link paths, would be a single hard-to-verify query) - this stays
 * simple to read and matches how getEffectiveRequirementLinks/getCoveringTestCases already
 * do the same direct-links-union-step-links computation elsewhere in this file's sibling
 * modules. Fine at the scale a single product's requirements/test cases/executions reach;
 * revisit if that ever stops being true.
 */
export async function getTraceabilityMatrix(db: TenantTx, tenantId: string, productId: string): Promise<TraceabilityRow[]> {
  const requirementRows = await db
    .select({
      id: schema.requirements.id,
      title: schema.requirementVersions.title,
      sequenceNumber: schema.requirements.sequenceNumber,
      levelName: schema.levels.name,
      levelCode: schema.levels.code,
      levelSortOrder: schema.levels.sortOrder,
    })
    .from(schema.requirements)
    .innerJoin(schema.requirementVersions, eq(schema.requirements.currentVersionId, schema.requirementVersions.id))
    .innerJoin(schema.levels, eq(schema.requirements.levelId, schema.levels.id))
    .where(and(eq(schema.requirements.tenantId, tenantId), eq(schema.requirements.productId, productId)))
    .orderBy(asc(schema.levels.sortOrder), asc(schema.requirementVersions.title));

  if (requirementRows.length === 0) return [];
  const requirementIds = requirementRows.map((r) => r.id);

  const directLinks = await db
    .select({ requirementId: schema.testCaseRequirementLinks.requirementId, testCaseId: schema.testCaseRequirementLinks.testCaseId })
    .from(schema.testCaseRequirementLinks)
    .where(and(eq(schema.testCaseRequirementLinks.tenantId, tenantId), inArray(schema.testCaseRequirementLinks.requirementId, requirementIds)));

  const stepLinks = await db
    .select({ requirementId: schema.testStepRequirementLinks.requirementId, testCaseId: schema.testSteps.testCaseId })
    .from(schema.testStepRequirementLinks)
    .innerJoin(schema.testSteps, eq(schema.testStepRequirementLinks.testStepId, schema.testSteps.id))
    .where(
      and(eq(schema.testStepRequirementLinks.tenantId, tenantId), inArray(schema.testStepRequirementLinks.requirementId, requirementIds)),
    );

  const testCaseIdsByRequirement = new Map<string, Set<string>>();
  for (const { requirementId, testCaseId } of [...directLinks, ...stepLinks]) {
    const set = testCaseIdsByRequirement.get(requirementId) ?? new Set<string>();
    set.add(testCaseId);
    testCaseIdsByRequirement.set(requirementId, set);
  }

  const allTestCaseIds = [...new Set([...directLinks, ...stepLinks].map((l) => l.testCaseId))];

  const testCases =
    allTestCaseIds.length === 0
      ? []
      : await db
          .select({
            id: schema.testCases.id,
            title: schema.testCases.title,
            sequenceNumber: schema.testCases.sequenceNumber,
            levelCode: schema.levels.code,
          })
          .from(schema.testCases)
          .innerJoin(schema.levels, eq(schema.testCases.levelId, schema.levels.id))
          .where(inArray(schema.testCases.id, allTestCaseIds));
  const testCaseById = new Map(testCases.map((tc) => [tc.id, tc]));

  const [requirementCustomFieldsById, testCaseCustomFieldsById] = await Promise.all([
    getCustomFieldValuesForEntities(db, tenantId, "requirement", requirementIds),
    allTestCaseIds.length
      ? getCustomFieldValuesForEntities(db, tenantId, "test_case", allTestCaseIds)
      : Promise.resolve(new Map<string, CustomFieldValueView[]>()),
  ]);

  const executions =
    allTestCaseIds.length === 0
      ? []
      : await db
          .select({
            testCaseId: schema.testExecutions.testCaseId,
            status: schema.testExecutions.status,
            startedAt: schema.testExecutions.startedAt,
            environmentName: schema.testEnvironments.name,
          })
          .from(schema.testExecutions)
          .innerJoin(schema.testEnvironments, eq(schema.testExecutions.environmentId, schema.testEnvironments.id))
          .where(and(eq(schema.testExecutions.tenantId, tenantId), inArray(schema.testExecutions.testCaseId, allTestCaseIds)))
          .orderBy(desc(schema.testExecutions.startedAt));
  // Executions are ordered newest-first, so the first one seen per test case is its most
  // recent - a plain "first write wins" map, not a max() computation.
  const lastExecutionByTestCase = new Map<string, (typeof executions)[number]>();
  for (const ex of executions) {
    if (!lastExecutionByTestCase.has(ex.testCaseId)) lastExecutionByTestCase.set(ex.testCaseId, ex);
  }

  const rows: TraceabilityRow[] = [];
  for (const req of requirementRows) {
    const testCaseIds = testCaseIdsByRequirement.get(req.id);
    if (!testCaseIds || testCaseIds.size === 0) {
      rows.push({
        requirementId: req.id,
        requirementTitle: req.title,
        requirementSequenceNumber: req.sequenceNumber,
        levelName: req.levelName,
        levelCode: req.levelCode,
        testCaseId: null,
        testCaseTitle: null,
        testCaseSequenceNumber: null,
        testCaseLevelCode: null,
        lastExecutionStatus: null,
        lastExecutionStartedAt: null,
        lastExecutionEnvironmentName: null,
        requirementCustomFieldValues: requirementCustomFieldsById.get(req.id) ?? [],
        testCaseCustomFieldValues: [],
      });
      continue;
    }
    for (const testCaseId of testCaseIds) {
      const testCase = testCaseById.get(testCaseId);
      const lastExecution = lastExecutionByTestCase.get(testCaseId);
      rows.push({
        requirementId: req.id,
        requirementTitle: req.title,
        requirementSequenceNumber: req.sequenceNumber,
        levelName: req.levelName,
        levelCode: req.levelCode,
        testCaseId,
        testCaseTitle: testCase?.title ?? null,
        testCaseSequenceNumber: testCase?.sequenceNumber ?? null,
        testCaseLevelCode: testCase?.levelCode ?? null,
        lastExecutionStatus: lastExecution?.status ?? null,
        lastExecutionStartedAt: lastExecution?.startedAt ?? null,
        lastExecutionEnvironmentName: lastExecution?.environmentName ?? null,
        requirementCustomFieldValues: requirementCustomFieldsById.get(req.id) ?? [],
        testCaseCustomFieldValues: testCaseCustomFieldsById.get(testCaseId) ?? [],
      });
    }
  }
  return rows;
}
