import { type TenantTx, schema } from "@galm/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import { getCustomFieldValues, getCustomFieldValuesForEntities } from "./custom-fields";
import { DomainError } from "./errors";
import { formatItemId } from "./item-id";
import {
  getOtsDocumentation,
  getOtsRegister,
  getOtsReleaseChanges,
  listUnresolvedOtsAnomaliesByRelease,
  OTS_PROFILE_TEXT_FIELDS,
} from "./ots";
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
  const customFieldValues = await getCustomFieldValues(db, tenantId, "test_run", executionId);

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
    customFields: customFieldValues.map((f) => ({
      name: f.name,
      value: f.fieldType === "list" ? f.optionLabel : f.value,
    })),
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

// --- OTS documentation ---------------------------------------------------------------

const OTS_CATEGORY_LABELS: Record<string, string> = {
  operating_system: "Operating system",
  driver: "Driver",
  utility: "Utility",
  library: "Library",
  framework: "Framework",
  runtime: "Runtime",
  database: "Database",
  cloud_service: "Cloud service",
  firmware: "Firmware",
  build_tool: "Build tool",
  other: "Other",
};
const OTS_SUPPORT_STATUS_LABELS: Record<string, string> = {
  in_use: "In use",
  allowed: "Allowed",
  retired: "Retired",
};
const OTS_OUTCOME_LABELS: Record<string, string> = {
  not_applicable: "Not applicable",
  acceptable: "Acceptable",
  mitigated: "Mitigated",
  not_acceptable: "Not acceptable",
};

function isoDate(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

function anomalyContext(a: Awaited<ReturnType<typeof getOtsDocumentation>>["anomalies"][number], versionLabel: (id: string) => string) {
  return {
    externalId: a.externalId,
    title: a.title,
    description: a.description,
    sourceUrl: a.sourceUrl,
    discoveryMethod: a.discoveryMethod,
    rootCause: a.rootCause,
    impactEvaluation: a.impactEvaluation,
    outcome: a.outcome ? OTS_OUTCOME_LABELS[a.outcome] ?? a.outcome : null,
    rationale: a.rationale,
    defectClassification: a.defectClassification,
    mitigation: a.mitigation,
    endUserCommunication: a.endUserCommunication,
    affectedVersions: a.affectedVersionIds.map(versionLabel),
    resolvedInVersion: a.resolvedInVersion,
    requirements: a.requirements.map((r) => ({ displayId: r.displayId, title: r.title })),
  };
}

/** Backs the `ots_component` scope. Dates are YYYY-MM-DD, enums are labels, and every
 * profile field is present (null when empty) so templates can `{{#if}}` it out. */
export async function buildOtsComponentDocumentContext(db: TenantTx, tenantId: string, architectureNodeId: string) {
  const doc = await getOtsDocumentation(db, tenantId, architectureNodeId);
  const [product] = await db.select({ name: schema.products.name }).from(schema.products).where(eq(schema.products.id, doc.node.productId));
  const versionById = new Map(doc.versions.map((v) => [v.id, v.version]));
  const versionLabel = (id: string) => versionById.get(id) ?? "unknown version";
  const current = doc.versions.find((v) => v.id === doc.node.currentVersionId) ?? null;

  const profile: Record<string, string | null> = {};
  for (const f of OTS_PROFILE_TEXT_FIELDS) profile[f.key] = doc.profile[f.key];

  return {
    generatedAt: nowIso(),
    productName: product?.name ?? "",
    displayId: doc.node.displayId,
    title: doc.node.title,
    supplier: doc.node.supplier,
    category: doc.profile.category ? OTS_CATEGORY_LABELS[doc.profile.category] ?? doc.profile.category : null,
    endOfSupportDate: isoDate(doc.profile.endOfSupportDate),
    anomaliesReviewedAt: isoDate(doc.profile.anomaliesReviewedAt),
    anomaliesReviewedBy: doc.anomaliesReviewedByName,
    ...profile,
    currentVersion: current
      ? {
          version: current.version,
          releaseDate: isoDate(current.releaseDate),
          patchLevel: current.patchLevel,
          upgradeDesignation: current.upgradeDesignation,
          cpe: current.cpe,
        }
      : null,
    allowedVersions: doc.versions.filter((v) => v.supportStatus === "allowed").map((v) => v.version),
    versions: doc.versions.map((v) => ({
      version: v.version,
      isCurrent: v.id === doc.node.currentVersionId,
      releaseDate: isoDate(v.releaseDate),
      patchLevel: v.patchLevel,
      upgradeDesignation: v.upgradeDesignation,
      releaseNotesUrl: v.releaseNotesUrl,
      cpe: v.cpe,
      supportStatus: OTS_SUPPORT_STATUS_LABELS[v.supportStatus] ?? v.supportStatus,
      recordedAt: isoDate(v.createdAt),
      shippedIn: v.softwareVersions.map((sv) => sv.versionNumber),
      assessment: v.assessment
        ? {
            safetyImpact: v.assessment.safetyImpact,
            designImpact: v.assessment.designImpact,
            installationImpact: v.assessment.installationImpact,
            obsolescenceImpact: v.assessment.obsolescenceImpact,
            regressionAnalysis: v.assessment.regressionAnalysis,
            verificationSummary: v.assessment.verificationSummary,
            regressionTestPerformed: v.assessment.regressionTestPerformed,
            testSetName: v.assessment.testSetName,
            assessedAt: isoDate(v.assessment.assessedAt),
          }
        : null,
    })),
    platforms: doc.platforms.map((p) => ({
      displayId: p.displayId,
      title: p.title,
      supplier: p.supplier,
      version: p.currentVersion?.version ?? null,
      patchLevel: p.currentVersion?.patchLevel ?? null,
      upgradeDesignation: p.currentVersion?.upgradeDesignation ?? null,
    })),
    anomalies: doc.anomalies.map((a) => anomalyContext(a, versionLabel)),
    requirements: doc.requirements.map((r) => ({ displayId: r.displayId, title: r.title })),
    testCases: doc.testCases.map((t) => ({ displayId: t.displayId, title: t.title })),
    completeness: {
      filled: doc.completeness.filled,
      total: doc.completeness.total,
      gaps: doc.completeness.gaps.map((g) => ({ message: g.message, enhancedOnly: g.enhancedOnly })),
    },
  };
}

/** Backs the `ots_list` scope: every component (same shape as `ots_component`), OTS
 * changes release to release, and unresolved known issues per release. */
export async function buildOtsListDocumentContext(db: TenantTx, tenantId: string, productId: string) {
  const [product] = await db.select({ name: schema.products.name }).from(schema.products).where(eq(schema.products.id, productId));
  if (!product) throw new DomainError("product not found");
  const register = await getOtsRegister(db, tenantId, productId);
  const components = [];
  for (const row of register) {
    components.push(await buildOtsComponentDocumentContext(db, tenantId, row.node.id));
  }
  const [releaseChanges, unresolvedByRelease] = await Promise.all([
    getOtsReleaseChanges(db, tenantId, productId),
    listUnresolvedOtsAnomaliesByRelease(db, tenantId, productId),
  ]);
  const nodeIds = register.map((r) => r.node.id);
  const versionRows = nodeIds.length
    ? await db
        .select({ id: schema.architectureNodeVersions.id, version: schema.architectureNodeVersions.version })
        .from(schema.architectureNodeVersions)
        .where(
          and(
            eq(schema.architectureNodeVersions.tenantId, tenantId),
            inArray(schema.architectureNodeVersions.architectureNodeId, nodeIds),
          ),
        )
    : [];
  const versionById = new Map(versionRows.map((v) => [v.id, v.version]));
  const versionLabel = (id: string) => versionById.get(id) ?? "unknown version";

  return {
    generatedAt: nowIso(),
    productName: product.name,
    componentCount: components.length,
    components,
    releaseChanges: releaseChanges.map((r) => ({
      versionNumber: r.release.versionNumber,
      releaseDate: isoDate(r.release.releaseDate),
      components: r.components,
      added: r.added,
      removed: r.removed,
      changed: r.changed.map((c) => ({
        displayId: c.displayId,
        title: c.title,
        from: c.from,
        to: c.to,
        assessments: c.assessments.map((a) => ({
          version: a.version,
          safetyImpact: a.safetyImpact,
          regressionAnalysis: a.regressionAnalysis,
          regressionTestPerformed: a.regressionTestPerformed,
          verificationSummary: a.verificationSummary,
        })),
      })),
      hasChanges: r.added.length + r.removed.length + r.changed.length > 0,
    })),
    unresolvedAnomaliesByRelease: unresolvedByRelease.map((r) => ({
      versionNumber: r.release.versionNumber,
      releaseDate: isoDate(r.release.releaseDate),
      anomalies: r.anomalies.map((a) => ({
        component: a.component,
        ...anomalyContext(a, versionLabel),
      })),
    })),
  };
}
