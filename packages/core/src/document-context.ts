import { type TenantTx, schema } from "@galm/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import { getCustomFieldValues, getCustomFieldValuesForEntities } from "./custom-fields";
import { DomainError } from "./errors";
import { formatItemId } from "./item-id";
import { getEffectiveRequirementLinks, getTestCaseWithSteps, getExecutionWithSteps } from "./test-cases";
import { getTestLevel } from "./test-levels";

/**
 * Builds the Handlebars context a document template of each scope renders against
 * (backlog item 9.29) - the entity data half of document generation; template
 * CRUD lives in document-templates.ts, actual rendering/PDF conversion in
 * `@galm/documents`. Every function here returns a plain, already-`await`ed object -
 * no lazy getters, nothing Handlebars-unfriendly - `generatedAt` is stamped in by each
 * one so every template has it available without needing it passed in separately.
 *
 * Evidence (uploaded files on a step execution) is deliberately listed by filename only,
 * not embedded as images - the actual bytes live in the storage package behind an
 * authenticated URL, and inlining them (base64 data URIs into the HTML wkhtmltopdf
 * renders) was cut from this first version as real added complexity for a case that's
 * easy to add later without changing anything else here.
 */

function nowIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function buildTestCaseDocumentContext(db: TenantTx, tenantId: string, testCaseId: string) {
  const { testCase, steps } = await getTestCaseWithSteps(db, tenantId, testCaseId);
  const level = await getTestLevel(db, tenantId, testCase.levelId);
  const requirements = await getEffectiveRequirementLinks(db, tenantId, testCaseId);
  const customFieldValues = await getCustomFieldValues(db, tenantId, "test_case", testCaseId);

  return {
    generatedAt: nowIso(),
    displayId: formatItemId(level.code, testCase.sequenceNumber),
    title: testCase.title,
    levelName: level.name,
    steps: steps.map((s) => ({
      position: s.stepNumber,
      description: s.description,
      expectedResult: s.expectedResult,
      purpose: s.purpose,
    })),
    requirements: requirements.map((r) => ({
      displayId: formatItemId(r.levelCode, r.sequenceNumber),
      title: r.title,
    })),
    customFields: customFieldValues.map((f) => ({
      name: f.name,
      value: f.fieldType === "list" ? f.optionLabel : f.value,
    })),
  };
}

export async function buildTestExecutionDocumentContext(db: TenantTx, tenantId: string, executionId: string) {
  const { execution, stepExecutions } = await getExecutionWithSteps(db, tenantId, executionId);
  const { testCase } = await getTestCaseWithSteps(db, tenantId, execution.testCaseId);
  const level = await getTestLevel(db, tenantId, testCase.levelId);

  const [environment] = await db
    .select({ name: schema.testEnvironments.name })
    .from(schema.testEnvironments)
    .where(and(eq(schema.testEnvironments.id, execution.environmentId), eq(schema.testEnvironments.tenantId, tenantId)));
  const [executedByUser] = await db.select({ name: schema.user.name }).from(schema.user).where(eq(schema.user.id, execution.executedBy));

  const evidenceByStepExecution = stepExecutions.length
    ? await db
        .select({ testStepExecutionId: schema.attachments.testStepExecutionId, filename: schema.attachments.filename })
        .from(schema.attachments)
        .where(
          and(
            eq(schema.attachments.tenantId, tenantId),
            inArray(
              schema.attachments.testStepExecutionId,
              stepExecutions.map((se) => se.id),
            ),
          ),
        )
    : [];
  const evidenceByStep = new Map<string, string[]>();
  for (const e of evidenceByStepExecution) {
    if (!e.testStepExecutionId) continue;
    const list = evidenceByStep.get(e.testStepExecutionId) ?? [];
    list.push(e.filename);
    evidenceByStep.set(e.testStepExecutionId, list);
  }

  return {
    generatedAt: nowIso(),
    testCase: { displayId: formatItemId(level.code, testCase.sequenceNumber), title: testCase.title },
    status: execution.status,
    environment: environment?.name ?? null,
    executedBy: executedByUser?.name ?? null,
    startedAt: execution.startedAt.toISOString(),
    completedAt: execution.completedAt ? execution.completedAt.toISOString() : null,
    steps: stepExecutions.map((se) => ({
      position: se.stepNumber,
      description: se.descriptionSnapshot,
      expectedResult: se.expectedResultSnapshot,
      actualResult: se.actualResult,
      status: se.status,
      recordedAt: se.recordedAt ? se.recordedAt.toISOString() : null,
      evidenceFilenames: evidenceByStep.get(se.id) ?? [],
    })),
  };
}

/** Backs the "requirement list" scope - the caller (the requirements list page, via the
 * generate-document API route) passes exactly the set of requirement ids currently shown
 * there (respecting whatever filters are active client-side), not a server-side
 * re-derivation of "everything in this level" - see BACKLOG.md 9.29 for why. Order is
 * whatever `requirementIds` was passed in, so the document matches what was on screen. */
export async function buildRequirementListDocumentContext(
  db: TenantTx,
  tenantId: string,
  requirementIds: string[],
  extra: { productName: string; levelName: string },
) {
  if (requirementIds.length === 0) {
    return { generatedAt: nowIso(), productName: extra.productName, levelName: extra.levelName, requirements: [] };
  }

  const rows = await db
    .select({
      id: schema.requirements.id,
      sequenceNumber: schema.requirements.sequenceNumber,
      title: schema.requirementVersions.title,
      description: schema.requirementVersions.description,
      background: schema.requirementVersions.background,
      statusName: schema.requirementStatuses.name,
      levelCode: schema.levels.code,
    })
    .from(schema.requirements)
    .innerJoin(schema.requirementVersions, eq(schema.requirements.currentVersionId, schema.requirementVersions.id))
    .innerJoin(schema.requirementStatuses, eq(schema.requirementVersions.statusId, schema.requirementStatuses.id))
    .innerJoin(schema.levels, eq(schema.requirements.levelId, schema.levels.id))
    .where(and(eq(schema.requirements.tenantId, tenantId), inArray(schema.requirements.id, requirementIds)));

  if (rows.length !== requirementIds.length) {
    // Not every requested id resolved (wrong tenant, or one was deleted between the list
    // rendering and clicking "Generate document") - fail loudly rather than silently
    // generating a document missing rows the operator asked for.
    throw new DomainError("one or more requirements could not be found");
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  const customFieldsByRequirement = await getCustomFieldValuesForEntities(db, tenantId, "requirement", requirementIds);

  return {
    generatedAt: nowIso(),
    productName: extra.productName,
    levelName: extra.levelName,
    requirements: requirementIds.map((id) => {
      const r = byId.get(id)!;
      return {
        displayId: formatItemId(r.levelCode, r.sequenceNumber),
        title: r.title,
        description: r.description,
        background: r.background,
        status: r.statusName,
        customFields: (customFieldsByRequirement.get(id) ?? []).map((f) => ({
          name: f.name,
          value: f.fieldType === "list" ? f.optionLabel : f.value,
        })),
      };
    }),
  };
}
