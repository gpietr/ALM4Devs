import { type TenantTx, schema } from "@galm/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  type ArchitectureNodeVersionView,
  listArchitectureNodeVersions,
  listRequirementLinksForNode,
  listTestCaseLinksForNode,
  OTS_VERSION_SUPPORT_STATUSES,
  type OtsVersionSupportStatus,
} from "./architecture";
import { writeAuditLog } from "./audit";
import { DomainError } from "./errors";
import { formatItemId } from "./item-id";
import { listSoftwareVersionsForEntities, type SoftwareVersionLinkView } from "./software-versions";

/**
 * OTS documentation shaped after FDA's "Off-The-Shelf Software Use in Medical Devices"
 * guidance (2023) - see the ots_* tables in packages/db/src/schema.ts. Every field is
 * optional; computeOtsCompleteness only reports gaps, it never blocks a save.
 */

export const OTS_CATEGORIES = [
  "operating_system",
  "driver",
  "utility",
  "library",
  "framework",
  "runtime",
  "database",
  "cloud_service",
  "firmware",
  "build_tool",
  "other",
] as const;
export type OtsCategory = (typeof OTS_CATEGORIES)[number];

export const OTS_ANOMALY_OUTCOMES = ["not_applicable", "acceptable", "mitigated", "not_acceptable"] as const;
export type OtsAnomalyOutcome = (typeof OTS_ANOMALY_OUTCOMES)[number];

/** After this long, a "known-issue list reviewed" attestation is reported as stale. */
export const OTS_ANOMALY_REVIEW_STALE_DAYS = 180;

/** The free-text profile fields - drives both upsert and completeness reporting.
 * `counted: false` fields are never reported as gaps (legitimately empty for most OTS);
 * `enhancedOnly` ones are reported muted and not counted (guidance section III.D). */
export const OTS_PROFILE_TEXT_FIELDS = [
  { key: "hostingEnvironment", label: "Hosting environment", counted: false },
  // III.A.1 What is it?
  { key: "endUserDocumentation", label: "OTS documentation provided to the end user" },
  { key: "appropriatenessRationale", label: "Why this OTS is appropriate for the product" },
  { key: "designLimitations", label: "Expected design limitations" },
  // III.A.2 Computer system specifications
  { key: "hardwareRequirements", label: "Hardware specifications" },
  { key: "softwareRequirements", label: "Software specifications" },
  // III.A.3 End-user actions
  { key: "installationConfiguration", label: "What can/must be installed or configured, and how" },
  { key: "configurationChangeFrequency", label: "How often the configuration changes" },
  { key: "userTraining", label: "End-user education and training" },
  { key: "nonSpecifiedSoftwarePrevention", label: "Measures preventing non-specified software" },
  // III.A.4 What does it do?
  { key: "intendedFunction", label: "What the OTS does in this product" },
  { key: "errorControlInvolvement", label: "Involvement in error control and messaging" },
  { key: "externalInterfaces", label: "Links with other / outside software" },
  // III.A.5 How do you know it works?
  { key: "anomalyListUrl", label: "Where the vendor's known-bug list lives" },
  { key: "updatesSourceUrl", label: "Where updates are obtained", counted: false },
  // III.A.6 Control
  { key: "versionControlMeasures", label: "Measures preventing incorrect versions" },
  { key: "configurationManagement", label: "How the OTS configuration is maintained" },
  { key: "storageLocation", label: "Where and how the OTS is stored" },
  { key: "installationVerification", label: "How proper installation is ensured" },
  { key: "maintenancePlan", label: "Maintenance and life cycle support" },
  // III.B Risk
  { key: "riskAssessment", label: "OTS risk assessment" },
  // III.D Assurance and continued maintenance
  { key: "developmentAssurance", label: "Assurance of the developer's methodologies", enhancedOnly: true },
  { key: "masterFileNumber", label: "Vendor master file reference", counted: false },
  { key: "supportMechanism", label: "Continued performance, maintenance and support", enhancedOnly: true },
  // Appendix A.5 Obsolescence
  { key: "retirementPlan", label: "Retirement / replacement plan", counted: false },
] as const satisfies ReadonlyArray<{
  key: keyof typeof schema.otsProfiles.$inferSelect;
  label: string;
  counted?: boolean;
  enhancedOnly?: boolean;
}>;

export type OtsProfileTextField = (typeof OTS_PROFILE_TEXT_FIELDS)[number]["key"];

export type OtsProfileInput = Partial<Record<OtsProfileTextField, string | null>> & {
  category?: OtsCategory | null;
  endOfSupportDate?: Date | null;
};

type OtsProfileRow = typeof schema.otsProfiles.$inferSelect;

/** A profile whether or not a row exists yet - an undocumented OTS item is all nulls. */
export type OtsProfileView = Omit<OtsProfileRow, "tenantId" | "updatedBy" | "updatedAt"> & {
  updatedAt: Date | null;
};

function emptyProfile(architectureNodeId: string): OtsProfileView {
  const view: Record<string, unknown> = {
    architectureNodeId,
    category: null,
    endOfSupportDate: null,
    anomaliesReviewedAt: null,
    anomaliesReviewedBy: null,
    updatedAt: null,
  };
  for (const f of OTS_PROFILE_TEXT_FIELDS) view[f.key] = null;
  return view as OtsProfileView;
}

// --- OTS node lookups ---------------------------------------------------------------

export interface OtsNodeRef {
  id: string;
  productId: string;
  title: string;
  supplier: string | null;
  sequenceNumber: number;
  levelId: string;
  levelCode: string;
  displayId: string;
  currentVersionId: string | null;
}

async function loadOtsNodes(
  db: TenantTx,
  tenantId: string,
  filter: { productId: string } | { ids: string[] },
): Promise<OtsNodeRef[]> {
  if ("ids" in filter && filter.ids.length === 0) return [];
  const rows = await db
    .select({
      id: schema.architectureNodes.id,
      productId: schema.architectureNodes.productId,
      kind: schema.architectureNodes.kind,
      title: schema.architectureNodes.title,
      supplier: schema.architectureNodes.supplier,
      sequenceNumber: schema.architectureNodes.sequenceNumber,
      currentVersionId: schema.architectureNodes.currentVersionId,
      levelId: schema.architectureNodes.levelId,
      levelCode: schema.levels.code,
    })
    .from(schema.architectureNodes)
    .innerJoin(schema.levels, eq(schema.architectureNodes.levelId, schema.levels.id))
    .where(
      and(
        eq(schema.architectureNodes.tenantId, tenantId),
        "ids" in filter
          ? inArray(schema.architectureNodes.id, [...new Set(filter.ids)])
          : and(eq(schema.architectureNodes.productId, filter.productId), eq(schema.architectureNodes.kind, "ots")),
      ),
    )
    .orderBy(asc(schema.levels.sortOrder), asc(schema.architectureNodes.sequenceNumber));
  return rows.map(({ kind: _kind, ...r }) => ({ ...r, displayId: formatItemId(r.levelCode, r.sequenceNumber) }));
}

/** Loads one node, failing unless it's an OTS item (an app-level rule, not a DB one). */
async function getOtsNode(db: TenantTx, tenantId: string, architectureNodeId: string): Promise<OtsNodeRef> {
  const [row] = await db
    .select({ kind: schema.architectureNodes.kind })
    .from(schema.architectureNodes)
    .where(and(eq(schema.architectureNodes.id, architectureNodeId), eq(schema.architectureNodes.tenantId, tenantId)));
  if (!row) throw new DomainError(`architecture node ${architectureNodeId} not found`);
  if (row.kind !== "ots") throw new DomainError("OTS documentation is only valid on OTS items");
  const [node] = await loadOtsNodes(db, tenantId, { ids: [architectureNodeId] });
  return node!;
}

/** Fails unless every id is one of this node's own recorded versions. */
async function assertVersionsBelongToNode(
  db: TenantTx,
  tenantId: string,
  architectureNodeId: string,
  versionIds: string[],
) {
  const unique = [...new Set(versionIds)];
  if (unique.length === 0) return;
  const rows = await db
    .select({ id: schema.architectureNodeVersions.id })
    .from(schema.architectureNodeVersions)
    .where(
      and(
        eq(schema.architectureNodeVersions.tenantId, tenantId),
        eq(schema.architectureNodeVersions.architectureNodeId, architectureNodeId),
        inArray(schema.architectureNodeVersions.id, unique),
      ),
    );
  if (rows.length !== unique.length) {
    throw new DomainError("one or more versions do not belong to this OTS item");
  }
}

function trimOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

// --- Profile ------------------------------------------------------------------------

async function getOtsProfile(db: TenantTx, tenantId: string, architectureNodeId: string): Promise<OtsProfileView> {
  const [row] = await db
    .select()
    .from(schema.otsProfiles)
    .where(and(eq(schema.otsProfiles.tenantId, tenantId), eq(schema.otsProfiles.architectureNodeId, architectureNodeId)));
  if (!row) return emptyProfile(architectureNodeId);
  const { tenantId: _tenantId, updatedBy: _updatedBy, ...view } = row;
  return view;
}

/** Partial upsert: only keys present in `fields` change; an empty string clears a field.
 * The review attestation is set only by markOtsAnomaliesReviewed. */
export async function upsertOtsProfile(
  db: TenantTx,
  params: { tenantId: string; architectureNodeId: string; fields: OtsProfileInput; actorUserId: string },
): Promise<OtsProfileView> {
  const node = await getOtsNode(db, params.tenantId, params.architectureNodeId);
  const { fields } = params;
  if (fields.category != null && !(OTS_CATEGORIES as readonly string[]).includes(fields.category)) {
    throw new DomainError(`unknown OTS category '${fields.category}'`);
  }

  const set: Partial<typeof schema.otsProfiles.$inferInsert> = {};
  for (const f of OTS_PROFILE_TEXT_FIELDS) {
    if (fields[f.key] !== undefined) set[f.key] = trimOrNull(fields[f.key]);
  }
  if (fields.category !== undefined) set.category = fields.category;
  if (fields.endOfSupportDate !== undefined) set.endOfSupportDate = fields.endOfSupportDate;
  const now = new Date();

  await db
    .insert(schema.otsProfiles)
    .values({
      ...set,
      architectureNodeId: node.id,
      tenantId: params.tenantId,
      updatedBy: params.actorUserId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.otsProfiles.architectureNodeId,
      set: { ...set, updatedBy: params.actorUserId, updatedAt: now },
    });

  await writeAuditLog(db, {
    tenantId: params.tenantId,
    actorUserId: params.actorUserId,
    action: "ots.profile_updated",
    entityType: "architecture_node",
    entityId: node.id,
    payload: { displayId: node.displayId, title: node.title, fields: Object.keys(set) },
  });

  return getOtsProfile(db, params.tenantId, node.id);
}

// --- Platform links (III.A.2) -------------------------------------------------------

export interface OtsPlatformLinkView extends OtsNodeRef {
  currentVersion: { version: string; patchLevel: string | null; upgradeDesignation: string | null } | null;
}

async function listOtsPlatformLinks(
  db: TenantTx,
  tenantId: string,
  architectureNodeId: string,
): Promise<OtsPlatformLinkView[]> {
  const links = await db
    .select({ platformNodeId: schema.otsPlatformLinks.platformNodeId })
    .from(schema.otsPlatformLinks)
    .where(
      and(eq(schema.otsPlatformLinks.tenantId, tenantId), eq(schema.otsPlatformLinks.architectureNodeId, architectureNodeId)),
    );
  const nodes = await loadOtsNodes(db, tenantId, { ids: links.map((l) => l.platformNodeId) });
  const versionIds = nodes.map((n) => n.currentVersionId).filter((id): id is string => !!id);
  const versions = versionIds.length
    ? await db
        .select({
          id: schema.architectureNodeVersions.id,
          version: schema.architectureNodeVersions.version,
          patchLevel: schema.architectureNodeVersions.patchLevel,
          upgradeDesignation: schema.architectureNodeVersions.upgradeDesignation,
        })
        .from(schema.architectureNodeVersions)
        .where(and(eq(schema.architectureNodeVersions.tenantId, tenantId), inArray(schema.architectureNodeVersions.id, versionIds)))
    : [];
  const versionById = new Map(versions.map((v) => [v.id, v]));
  return nodes.map((n) => {
    const v = n.currentVersionId ? versionById.get(n.currentVersionId) : undefined;
    return {
      ...n,
      currentVersion: v ? { version: v.version, patchLevel: v.patchLevel, upgradeDesignation: v.upgradeDesignation } : null,
    };
  });
}

/** Replace-all "runs on" links. Platforms are other OTS items in the same product, so
 * their own recorded versions and patches describe the platform. */
export async function replaceOtsPlatformLinks(
  db: TenantTx,
  params: { tenantId: string; architectureNodeId: string; platformNodeIds: string[]; actorUserId: string },
) {
  const node = await getOtsNode(db, params.tenantId, params.architectureNodeId);
  const unique = [...new Set(params.platformNodeIds)];
  if (unique.includes(node.id)) throw new DomainError("an OTS item cannot be its own platform");
  if (unique.length > 0) {
    const rows = await db
      .select({
        id: schema.architectureNodes.id,
        productId: schema.architectureNodes.productId,
        kind: schema.architectureNodes.kind,
      })
      .from(schema.architectureNodes)
      .where(and(eq(schema.architectureNodes.tenantId, params.tenantId), inArray(schema.architectureNodes.id, unique)));
    if (rows.length !== unique.length) throw new DomainError("one or more platform items were not found");
    if (rows.some((r) => r.productId !== node.productId)) {
      throw new DomainError("platform items must belong to the same product");
    }
    if (rows.some((r) => r.kind !== "ots")) throw new DomainError("platform items must be OTS items");
  }

  await db
    .delete(schema.otsPlatformLinks)
    .where(
      and(eq(schema.otsPlatformLinks.tenantId, params.tenantId), eq(schema.otsPlatformLinks.architectureNodeId, node.id)),
    );
  if (unique.length > 0) {
    await db.insert(schema.otsPlatformLinks).values(
      unique.map((platformNodeId) => ({ tenantId: params.tenantId, architectureNodeId: node.id, platformNodeId })),
    );
  }

  await writeAuditLog(db, {
    tenantId: params.tenantId,
    actorUserId: params.actorUserId,
    action: "ots.platform_links_updated",
    entityType: "architecture_node",
    entityId: node.id,
    payload: { displayId: node.displayId, platformNodeIds: unique },
  });
}

// --- Versions: support status + change-impact assessment ------------------------------

export async function setArchitectureNodeVersionSupportStatus(
  db: TenantTx,
  params: {
    tenantId: string;
    architectureNodeId: string;
    versionId: string;
    supportStatus: OtsVersionSupportStatus;
    actorUserId: string;
  },
) {
  const node = await getOtsNode(db, params.tenantId, params.architectureNodeId);
  if (!(OTS_VERSION_SUPPORT_STATUSES as readonly string[]).includes(params.supportStatus)) {
    throw new DomainError(`unknown support status '${params.supportStatus}'`);
  }
  await assertVersionsBelongToNode(db, params.tenantId, node.id, [params.versionId]);
  const [row] = await db
    .update(schema.architectureNodeVersions)
    .set({ supportStatus: params.supportStatus })
    .where(
      and(eq(schema.architectureNodeVersions.id, params.versionId), eq(schema.architectureNodeVersions.tenantId, params.tenantId)),
    )
    .returning({ version: schema.architectureNodeVersions.version });

  await writeAuditLog(db, {
    tenantId: params.tenantId,
    actorUserId: params.actorUserId,
    action: "ots.version_status_changed",
    entityType: "architecture_node",
    entityId: node.id,
    payload: { displayId: node.displayId, versionId: params.versionId, version: row?.version, supportStatus: params.supportStatus },
  });
}

export type OtsVersionAssessmentView = Omit<typeof schema.otsVersionAssessments.$inferSelect, "tenantId"> & {
  testSetName: string | null;
};

export interface OtsVersionAssessmentInput {
  safetyImpact?: string | null;
  designImpact?: string | null;
  installationImpact?: string | null;
  obsolescenceImpact?: string | null;
  regressionAnalysis?: string | null;
  verificationSummary?: string | null;
  regressionTestPerformed?: boolean;
  testSetId?: string | null;
}

async function loadVersionAssessments(
  db: TenantTx,
  tenantId: string,
  versionIds: string[],
): Promise<Map<string, OtsVersionAssessmentView>> {
  const map = new Map<string, OtsVersionAssessmentView>();
  if (versionIds.length === 0) return map;
  const rows = await db
    .select({ assessment: schema.otsVersionAssessments, testSetName: schema.testSets.name })
    .from(schema.otsVersionAssessments)
    .leftJoin(schema.testSets, eq(schema.otsVersionAssessments.testSetId, schema.testSets.id))
    .where(
      and(
        eq(schema.otsVersionAssessments.tenantId, tenantId),
        inArray(schema.otsVersionAssessments.architectureNodeVersionId, versionIds),
      ),
    );
  for (const { assessment, testSetName } of rows) {
    const { tenantId: _tenantId, ...rest } = assessment;
    map.set(assessment.architectureNodeVersionId, { ...rest, testSetName: testSetName ?? null });
  }
  return map;
}

/** Replace-all save of one version's change-impact assessment; re-stamps assessedBy/At. */
export async function upsertOtsVersionAssessment(
  db: TenantTx,
  params: {
    tenantId: string;
    architectureNodeId: string;
    versionId: string;
    fields: OtsVersionAssessmentInput;
    actorUserId: string;
  },
) {
  const node = await getOtsNode(db, params.tenantId, params.architectureNodeId);
  await assertVersionsBelongToNode(db, params.tenantId, node.id, [params.versionId]);
  if (params.fields.testSetId) {
    const [set] = await db
      .select({ productId: schema.testSets.productId })
      .from(schema.testSets)
      .where(and(eq(schema.testSets.id, params.fields.testSetId), eq(schema.testSets.tenantId, params.tenantId)));
    if (!set) throw new DomainError("test set not found");
    if (set.productId !== node.productId) throw new DomainError("test set must belong to the same product");
  }

  const values = {
    safetyImpact: trimOrNull(params.fields.safetyImpact),
    designImpact: trimOrNull(params.fields.designImpact),
    installationImpact: trimOrNull(params.fields.installationImpact),
    obsolescenceImpact: trimOrNull(params.fields.obsolescenceImpact),
    regressionAnalysis: trimOrNull(params.fields.regressionAnalysis),
    verificationSummary: trimOrNull(params.fields.verificationSummary),
    regressionTestPerformed: params.fields.regressionTestPerformed ?? false,
    testSetId: params.fields.testSetId ?? null,
    assessedBy: params.actorUserId,
    assessedAt: new Date(),
  };
  await db
    .insert(schema.otsVersionAssessments)
    .values({ ...values, tenantId: params.tenantId, architectureNodeVersionId: params.versionId })
    .onConflictDoUpdate({ target: schema.otsVersionAssessments.architectureNodeVersionId, set: values });

  await writeAuditLog(db, {
    tenantId: params.tenantId,
    actorUserId: params.actorUserId,
    action: "ots.version_assessed",
    entityType: "architecture_node",
    entityId: node.id,
    payload: { displayId: node.displayId, versionId: params.versionId, regressionTestPerformed: values.regressionTestPerformed },
  });
}

// --- Known issues (stored as "anomalies") ---------------------------------------------

export interface OtsAnomalyInput {
  externalId?: string | null;
  title: string;
  description?: string;
  sourceUrl?: string | null;
  discoveryMethod?: string | null;
  rootCause?: string | null;
  impactEvaluation?: string | null;
  outcome?: OtsAnomalyOutcome | null;
  rationale?: string | null;
  defectClassification?: string | null;
  mitigation?: string | null;
  endUserCommunication?: string | null;
  resolvedInVersion?: string | null;
  affectedVersionIds?: string[];
  requirementIds?: string[];
}

export type OtsAnomalyView = Omit<typeof schema.otsAnomalies.$inferSelect, "tenantId"> & {
  affectedVersionIds: string[];
  requirements: { id: string; displayId: string; title: string }[];
};

async function assertSameProductRequirementIds(db: TenantTx, tenantId: string, productId: string, ids: string[]) {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  const rows = await db
    .select({ id: schema.requirements.id, productId: schema.requirements.productId })
    .from(schema.requirements)
    .where(and(eq(schema.requirements.tenantId, tenantId), inArray(schema.requirements.id, unique)));
  if (rows.length !== unique.length) throw new DomainError("one or more requirements were not found");
  if (rows.some((r) => r.productId !== productId)) throw new DomainError("linked requirements must belong to the same product");
}

/** Validates and normalizes a known-issue write. The module's one required-field rule:
 * recording an outcome requires a rationale. */
async function prepareAnomaly(db: TenantTx, tenantId: string, node: OtsNodeRef, input: OtsAnomalyInput) {
  const title = input.title.trim();
  if (!title) throw new DomainError("a known issue needs a title");
  if (input.outcome != null && !(OTS_ANOMALY_OUTCOMES as readonly string[]).includes(input.outcome)) {
    throw new DomainError(`unknown known-issue outcome '${input.outcome}'`);
  }
  const rationale = trimOrNull(input.rationale);
  if (input.outcome && !rationale) {
    throw new DomainError("a rationale is required when recording the outcome of a known issue's evaluation");
  }
  await assertVersionsBelongToNode(db, tenantId, node.id, input.affectedVersionIds ?? []);
  await assertSameProductRequirementIds(db, tenantId, node.productId, input.requirementIds ?? []);
  return {
    externalId: trimOrNull(input.externalId),
    title,
    description: input.description?.trim() ?? "",
    sourceUrl: trimOrNull(input.sourceUrl),
    discoveryMethod: trimOrNull(input.discoveryMethod),
    rootCause: trimOrNull(input.rootCause),
    impactEvaluation: trimOrNull(input.impactEvaluation),
    outcome: input.outcome ?? null,
    rationale,
    defectClassification: trimOrNull(input.defectClassification),
    mitigation: trimOrNull(input.mitigation),
    endUserCommunication: trimOrNull(input.endUserCommunication),
    resolvedInVersion: trimOrNull(input.resolvedInVersion),
  };
}

async function replaceAnomalyLinks(
  db: TenantTx,
  tenantId: string,
  anomalyId: string,
  input: { affectedVersionIds?: string[]; requirementIds?: string[] },
) {
  if (input.affectedVersionIds !== undefined) {
    await db
      .delete(schema.otsAnomalyVersions)
      .where(and(eq(schema.otsAnomalyVersions.tenantId, tenantId), eq(schema.otsAnomalyVersions.anomalyId, anomalyId)));
    const unique = [...new Set(input.affectedVersionIds)];
    if (unique.length > 0) {
      await db
        .insert(schema.otsAnomalyVersions)
        .values(unique.map((architectureNodeVersionId) => ({ tenantId, anomalyId, architectureNodeVersionId })));
    }
  }
  if (input.requirementIds !== undefined) {
    await db
      .delete(schema.otsAnomalyRequirementLinks)
      .where(
        and(eq(schema.otsAnomalyRequirementLinks.tenantId, tenantId), eq(schema.otsAnomalyRequirementLinks.anomalyId, anomalyId)),
      );
    const unique = [...new Set(input.requirementIds)];
    if (unique.length > 0) {
      await db
        .insert(schema.otsAnomalyRequirementLinks)
        .values(unique.map((requirementId) => ({ tenantId, anomalyId, requirementId })));
    }
  }
}

async function loadAnomalies(
  db: TenantTx,
  tenantId: string,
  architectureNodeIds: string[],
): Promise<Map<string, OtsAnomalyView[]>> {
  const byNode = new Map<string, OtsAnomalyView[]>();
  if (architectureNodeIds.length === 0) return byNode;
  const rows = await db
    .select()
    .from(schema.otsAnomalies)
    .where(and(eq(schema.otsAnomalies.tenantId, tenantId), inArray(schema.otsAnomalies.architectureNodeId, architectureNodeIds)))
    .orderBy(asc(schema.otsAnomalies.createdAt));
  if (rows.length === 0) return byNode;
  const anomalyIds = rows.map((r) => r.id);
  const [versionRows, requirementRows] = await Promise.all([
    db
      .select()
      .from(schema.otsAnomalyVersions)
      .where(and(eq(schema.otsAnomalyVersions.tenantId, tenantId), inArray(schema.otsAnomalyVersions.anomalyId, anomalyIds))),
    db
      .select({
        anomalyId: schema.otsAnomalyRequirementLinks.anomalyId,
        id: schema.requirements.id,
        sequenceNumber: schema.requirements.sequenceNumber,
        title: schema.requirementVersions.title,
        levelCode: schema.levels.code,
      })
      .from(schema.otsAnomalyRequirementLinks)
      .innerJoin(schema.requirements, eq(schema.otsAnomalyRequirementLinks.requirementId, schema.requirements.id))
      .innerJoin(schema.requirementVersions, eq(schema.requirements.currentVersionId, schema.requirementVersions.id))
      .innerJoin(schema.levels, eq(schema.requirements.levelId, schema.levels.id))
      .where(
        and(
          eq(schema.otsAnomalyRequirementLinks.tenantId, tenantId),
          inArray(schema.otsAnomalyRequirementLinks.anomalyId, anomalyIds),
        ),
      )
      .orderBy(asc(schema.levels.sortOrder), asc(schema.requirements.sequenceNumber)),
  ]);
  for (const row of rows) {
    const { tenantId: _tenantId, ...rest } = row;
    const list = byNode.get(row.architectureNodeId) ?? [];
    list.push({
      ...rest,
      affectedVersionIds: versionRows.filter((v) => v.anomalyId === row.id).map((v) => v.architectureNodeVersionId),
      requirements: requirementRows
        .filter((r) => r.anomalyId === row.id)
        .map((r) => ({ id: r.id, title: r.title, displayId: formatItemId(r.levelCode, r.sequenceNumber) })),
    });
    byNode.set(row.architectureNodeId, list);
  }
  return byNode;
}

async function listOtsAnomalies(db: TenantTx, tenantId: string, architectureNodeId: string) {
  return (await loadAnomalies(db, tenantId, [architectureNodeId])).get(architectureNodeId) ?? [];
}

async function getAnomalyRow(db: TenantTx, tenantId: string, anomalyId: string) {
  const [row] = await db
    .select()
    .from(schema.otsAnomalies)
    .where(and(eq(schema.otsAnomalies.id, anomalyId), eq(schema.otsAnomalies.tenantId, tenantId)));
  if (!row) throw new DomainError(`known issue ${anomalyId} not found`);
  return row;
}

export async function createOtsAnomaly(
  db: TenantTx,
  params: { tenantId: string; architectureNodeId: string; input: OtsAnomalyInput; actorUserId: string },
) {
  const node = await getOtsNode(db, params.tenantId, params.architectureNodeId);
  const values = await prepareAnomaly(db, params.tenantId, node, params.input);
  const [row] = await db
    .insert(schema.otsAnomalies)
    .values({
      ...values,
      tenantId: params.tenantId,
      architectureNodeId: node.id,
      createdBy: params.actorUserId,
      updatedBy: params.actorUserId,
    })
    .returning({ id: schema.otsAnomalies.id });
  if (!row) throw new DomainError("failed to create known issue");
  await replaceAnomalyLinks(db, params.tenantId, row.id, {
    affectedVersionIds: params.input.affectedVersionIds ?? [],
    requirementIds: params.input.requirementIds ?? [],
  });

  await writeAuditLog(db, {
    tenantId: params.tenantId,
    actorUserId: params.actorUserId,
    action: "ots.anomaly_created",
    entityType: "architecture_node",
    entityId: node.id,
    payload: { displayId: node.displayId, anomalyId: row.id, title: values.title, outcome: values.outcome },
  });
  return { id: row.id };
}

export async function updateOtsAnomaly(
  db: TenantTx,
  params: { tenantId: string; anomalyId: string; input: OtsAnomalyInput; actorUserId: string },
) {
  const existing = await getAnomalyRow(db, params.tenantId, params.anomalyId);
  const node = await getOtsNode(db, params.tenantId, existing.architectureNodeId);
  const values = await prepareAnomaly(db, params.tenantId, node, params.input);
  await db
    .update(schema.otsAnomalies)
    .set({ ...values, updatedBy: params.actorUserId, updatedAt: new Date() })
    .where(and(eq(schema.otsAnomalies.id, existing.id), eq(schema.otsAnomalies.tenantId, params.tenantId)));
  await replaceAnomalyLinks(db, params.tenantId, existing.id, params.input);

  await writeAuditLog(db, {
    tenantId: params.tenantId,
    actorUserId: params.actorUserId,
    action: "ots.anomaly_updated",
    entityType: "architecture_node",
    entityId: node.id,
    payload: { displayId: node.displayId, anomalyId: existing.id, title: values.title, outcome: values.outcome },
  });
}

export async function deleteOtsAnomaly(db: TenantTx, params: { tenantId: string; anomalyId: string; actorUserId: string }) {
  const existing = await getAnomalyRow(db, params.tenantId, params.anomalyId);
  const node = await getOtsNode(db, params.tenantId, existing.architectureNodeId);
  await db
    .delete(schema.otsAnomalies)
    .where(and(eq(schema.otsAnomalies.id, existing.id), eq(schema.otsAnomalies.tenantId, params.tenantId)));

  await writeAuditLog(db, {
    tenantId: params.tenantId,
    actorUserId: params.actorUserId,
    action: "ots.anomaly_deleted",
    entityType: "architecture_node",
    entityId: node.id,
    payload: { displayId: node.displayId, anomalyId: existing.id, title: existing.title },
  });
}

export async function listOtsAnomalyExternalIds(db: TenantTx, tenantId: string, architectureNodeId: string) {
  const rows = await db
    .select({ externalId: schema.otsAnomalies.externalId })
    .from(schema.otsAnomalies)
    .where(and(eq(schema.otsAnomalies.tenantId, tenantId), eq(schema.otsAnomalies.architectureNodeId, architectureNodeId)));
  return new Set(rows.flatMap((r) => (r.externalId ? [r.externalId] : [])));
}

/** Bulk-creates known issues, skipping external ids the OTS item already has. */
export async function importOtsAnomalies(
  db: TenantTx,
  params: {
    tenantId: string;
    architectureNodeId: string;
    items: (OtsAnomalyInput & { externalId: string })[];
    source: string;
    actorUserId: string;
  },
) {
  const node = await getOtsNode(db, params.tenantId, params.architectureNodeId);
  const seen = await listOtsAnomalyExternalIds(db, params.tenantId, node.id);
  const toInsert = [];
  for (const item of params.items) {
    if (seen.has(item.externalId)) continue;
    seen.add(item.externalId);
    toInsert.push({
      ...(await prepareAnomaly(db, params.tenantId, node, item)),
      tenantId: params.tenantId,
      architectureNodeId: node.id,
      createdBy: params.actorUserId,
      updatedBy: params.actorUserId,
    });
  }
  if (toInsert.length > 0) {
    await db.insert(schema.otsAnomalies).values(toInsert);
    await writeAuditLog(db, {
      tenantId: params.tenantId,
      actorUserId: params.actorUserId,
      action: "ots.anomalies_imported",
      entityType: "architecture_node",
      entityId: node.id,
      payload: {
        displayId: node.displayId,
        source: params.source,
        count: toInsert.length,
        externalIds: toInsert.map((v) => v.externalId),
      },
    });
  }
  return { imported: toInsert.length, skipped: params.items.length - toInsert.length };
}

/** Attests the known-issue list is current. A separate action from the profile save, so
 * the timestamp means a review actually happened. */
export async function markOtsAnomaliesReviewed(
  db: TenantTx,
  params: { tenantId: string; architectureNodeId: string; actorUserId: string },
) {
  const node = await getOtsNode(db, params.tenantId, params.architectureNodeId);
  const now = new Date();
  await db
    .insert(schema.otsProfiles)
    .values({
      architectureNodeId: node.id,
      tenantId: params.tenantId,
      anomaliesReviewedAt: now,
      anomaliesReviewedBy: params.actorUserId,
      updatedBy: params.actorUserId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.otsProfiles.architectureNodeId,
      set: { anomaliesReviewedAt: now, anomaliesReviewedBy: params.actorUserId },
    });

  await writeAuditLog(db, {
    tenantId: params.tenantId,
    actorUserId: params.actorUserId,
    action: "ots.anomalies_reviewed",
    entityType: "architecture_node",
    entityId: node.id,
    payload: { displayId: node.displayId },
  });
}

// --- Completeness (informational only) -------------------------------------------------

export interface OtsCompletenessGap {
  field: string;
  message: string;
  /** Usually only needed for higher-risk products; shown muted and not counted. */
  enhancedOnly: boolean;
}

export interface OtsCompleteness {
  filled: number;
  total: number;
  gaps: OtsCompletenessGap[];
}

export interface OtsCompletenessInput {
  profile: OtsProfileView;
  versions: Array<{ id: string; version: string; supportStatus: string; hasAssessment: boolean }>;
  currentVersionId: string | null;
  anomalies: Array<{ outcome: string | null }>;
  now?: Date;
}

/** Pure - what's still empty or inconsistent in one OTS item's documentation. */
export function computeOtsCompleteness(input: OtsCompletenessInput): OtsCompleteness {
  const { profile } = input;
  const now = input.now ?? new Date();
  const gaps: OtsCompletenessGap[] = [];
  let filled = 0;
  let total = 0;

  total++;
  if (profile.category) filled++;
  else gaps.push({ field: "category", message: "Category (OS, driver, library, …) not set", enhancedOnly: false });

  for (const f of OTS_PROFILE_TEXT_FIELDS) {
    const field = f as { key: OtsProfileTextField; label: string; counted?: boolean; enhancedOnly?: boolean };
    if (field.counted === false) continue;
    const empty = !profile[field.key];
    const enhancedOnly = field.enhancedOnly === true;
    if (empty) gaps.push({ field: field.key, message: `${field.label} not documented`, enhancedOnly });
    if (enhancedOnly) continue;
    total++;
    if (!empty) filled++;
  }

  // Consistency hints - not counted towards filled/total.
  const hint = (field: string, message: string) => gaps.push({ field, message, enhancedOnly: false });
  if (!input.currentVersionId) hint("version", "No version recorded");
  for (const v of input.versions) {
    if (v.supportStatus === "allowed" && !v.hasAssessment) {
      hint("versionAssessment", `Version ${v.version} is allowed but has no change-impact/validation assessment`);
    }
  }
  if (!profile.anomaliesReviewedAt) {
    hint("anomaliesReviewedAt", "Known-issue list never marked as reviewed");
  } else if (now.getTime() - profile.anomaliesReviewedAt.getTime() > OTS_ANOMALY_REVIEW_STALE_DAYS * 86_400_000) {
    hint("anomaliesReviewedAt", `Known-issue list last reviewed more than ${OTS_ANOMALY_REVIEW_STALE_DAYS} days ago`);
  }
  const unassessed = input.anomalies.filter((a) => !a.outcome).length;
  if (unassessed > 0) hint("anomalies", `${unassessed} known ${unassessed === 1 ? "issue has" : "issues have"} no evaluation outcome`);
  if (profile.endOfSupportDate && profile.endOfSupportDate.getTime() <= now.getTime() && !profile.retirementPlan) {
    hint("retirementPlan", "Vendor support has ended but there is no retirement / replacement plan");
  }

  return { filled, total, gaps };
}

// --- Full documentation for one OTS item -------------------------------------------------

export type OtsVersionDocView = ArchitectureNodeVersionView & {
  assessment: OtsVersionAssessmentView | null;
  softwareVersions: SoftwareVersionLinkView[];
};

/** Everything documented about one OTS item - backs its detail tabs and the
 * `ots_component` document context. */
export async function getOtsDocumentation(db: TenantTx, tenantId: string, architectureNodeId: string) {
  const node = await getOtsNode(db, tenantId, architectureNodeId);
  const [profile, platforms, versionRows, anomalies, requirements, testCases] = await Promise.all([
    getOtsProfile(db, tenantId, node.id),
    listOtsPlatformLinks(db, tenantId, node.id),
    listArchitectureNodeVersions(db, tenantId, node.id),
    listOtsAnomalies(db, tenantId, node.id),
    listRequirementLinksForNode(db, tenantId, node.id),
    listTestCaseLinksForNode(db, tenantId, node.id),
  ]);
  const versionIds = versionRows.map((v) => v.id);
  const [assessments, softwareVersionsByVersion] = await Promise.all([
    loadVersionAssessments(db, tenantId, versionIds),
    listSoftwareVersionsForEntities(db, tenantId, "architecture_node_version", versionIds),
  ]);
  const versions: OtsVersionDocView[] = versionRows.map((v) => ({
    ...v,
    assessment: assessments.get(v.id) ?? null,
    softwareVersions: softwareVersionsByVersion.get(v.id) ?? [],
  }));
  const reviewer = profile.anomaliesReviewedBy
    ? (
        await db
          .select({ name: schema.user.name })
          .from(schema.user)
          .where(eq(schema.user.id, profile.anomaliesReviewedBy))
      )[0]?.name ?? null
    : null;
  const completeness = computeOtsCompleteness({
    profile,
    versions: versions.map((v) => ({ id: v.id, version: v.version, supportStatus: v.supportStatus, hasAssessment: !!v.assessment })),
    currentVersionId: node.currentVersionId,
    anomalies,
  });
  return {
    node,
    profile,
    anomaliesReviewedByName: reviewer,
    platforms,
    versions,
    anomalies,
    requirements,
    testCases,
    completeness,
  };
}

// --- Product-wide register -------------------------------------------------------------

/** One row per OTS item across all architecture levels of a product (batched queries). */
export async function getOtsRegister(db: TenantTx, tenantId: string, productId: string) {
  const nodes = await loadOtsNodes(db, tenantId, { productId });
  if (nodes.length === 0) return [];
  const nodeIds = nodes.map((n) => n.id);

  const [profileRows, versionRows, anomaliesByNode, findingRows, annotationRows, testLinkRows] = await Promise.all([
    db
      .select()
      .from(schema.otsProfiles)
      .where(and(eq(schema.otsProfiles.tenantId, tenantId), inArray(schema.otsProfiles.architectureNodeId, nodeIds))),
    db
      .select({
        id: schema.architectureNodeVersions.id,
        architectureNodeId: schema.architectureNodeVersions.architectureNodeId,
        version: schema.architectureNodeVersions.version,
        patchLevel: schema.architectureNodeVersions.patchLevel,
        supportStatus: schema.architectureNodeVersions.supportStatus,
      })
      .from(schema.architectureNodeVersions)
      .where(
        and(
          eq(schema.architectureNodeVersions.tenantId, tenantId),
          inArray(schema.architectureNodeVersions.architectureNodeId, nodeIds),
        ),
      )
      .orderBy(asc(schema.architectureNodeVersions.createdAt)),
    loadAnomalies(db, tenantId, nodeIds),
    db
      .select({ architectureNodeId: schema.vulnerabilityFindings.architectureNodeId, cveId: schema.vulnerabilityFindings.cveId })
      .from(schema.vulnerabilityFindings)
      .where(and(eq(schema.vulnerabilityFindings.tenantId, tenantId), inArray(schema.vulnerabilityFindings.architectureNodeId, nodeIds))),
    db
      .select({
        architectureNodeId: schema.vulnerabilityAnnotations.architectureNodeId,
        cveId: schema.vulnerabilityAnnotations.cveId,
        affectsProduct: schema.vulnerabilityAnnotations.affectsProduct,
        falsePositive: schema.vulnerabilityAnnotations.falsePositive,
      })
      .from(schema.vulnerabilityAnnotations)
      .where(
        and(eq(schema.vulnerabilityAnnotations.tenantId, tenantId), inArray(schema.vulnerabilityAnnotations.architectureNodeId, nodeIds)),
      ),
    db
      .select({ architectureNodeId: schema.architectureNodeTestCaseLinks.architectureNodeId })
      .from(schema.architectureNodeTestCaseLinks)
      .where(
        and(
          eq(schema.architectureNodeTestCaseLinks.tenantId, tenantId),
          inArray(schema.architectureNodeTestCaseLinks.architectureNodeId, nodeIds),
        ),
      ),
  ]);
  const assessments = await loadVersionAssessments(
    db,
    tenantId,
    versionRows.map((v) => v.id),
  );

  const profileByNode = new Map(profileRows.map((p) => [p.architectureNodeId, p]));
  const annotationByPair = new Map(annotationRows.map((a) => [`${a.architectureNodeId}:${a.cveId}`, a]));

  return nodes.map((node) => {
    const row = profileByNode.get(node.id);
    let profile: OtsProfileView;
    if (row) {
      const { tenantId: _tenantId, updatedBy: _updatedBy, ...rest } = row;
      profile = rest;
    } else {
      profile = emptyProfile(node.id);
    }
    const versions = versionRows.filter((v) => v.architectureNodeId === node.id);
    const current = versions.find((v) => v.id === node.currentVersionId) ?? null;
    const anomalies = anomaliesByNode.get(node.id) ?? [];
    // Untriaged CVEs count as open, same default as vulnerability_annotations.
    const openCves = findingRows.filter((f) => {
      if (f.architectureNodeId !== node.id) return false;
      const a = annotationByPair.get(`${f.architectureNodeId}:${f.cveId}`);
      return !a || (a.affectsProduct && !a.falsePositive);
    }).length;
    const completeness = computeOtsCompleteness({
      profile,
      versions: versions.map((v) => ({ id: v.id, version: v.version, supportStatus: v.supportStatus, hasAssessment: assessments.has(v.id) })),
      currentVersionId: node.currentVersionId,
      anomalies,
    });
    return {
      node,
      category: profile.category,
      endOfSupportDate: profile.endOfSupportDate,
      intendedFunction: profile.intendedFunction,
      anomaliesReviewedAt: profile.anomaliesReviewedAt,
      currentVersion: current ? { id: current.id, version: current.version, patchLevel: current.patchLevel } : null,
      allowedVersions: versions.filter((v) => v.supportStatus === "allowed").map((v) => v.version),
      anomalyCounts: {
        total: anomalies.length,
        unassessed: anomalies.filter((a) => !a.outcome).length,
        notAcceptable: anomalies.filter((a) => a.outcome === "not_acceptable").length,
      },
      openCveCount: openCves,
      linkedTestCaseCount: testLinkRows.filter((l) => l.architectureNodeId === node.id).length,
      completeness,
    };
  });
}

// --- Product releases: OTS changes and unresolved known issues ---------------------------

interface ReleaseComponentVersion {
  id: string;
  version: string;
  patchLevel: string | null;
}

/** Every product release with the OTS versions tagged as shipping in it, oldest first. */
async function loadReleaseComponents(db: TenantTx, tenantId: string, productId: string) {
  const releases = await db
    .select({
      id: schema.softwareVersions.id,
      versionNumber: schema.softwareVersions.versionNumber,
      releaseDate: schema.softwareVersions.releaseDate,
      createdAt: schema.softwareVersions.createdAt,
    })
    .from(schema.softwareVersions)
    .where(and(eq(schema.softwareVersions.tenantId, tenantId), eq(schema.softwareVersions.productId, productId)));
  // Dateless (unreleased) versions sort after dated ones.
  releases.sort((a, b) => {
    const ad = a.releaseDate?.getTime() ?? Number.POSITIVE_INFINITY;
    const bd = b.releaseDate?.getTime() ?? Number.POSITIVE_INFINITY;
    return ad !== bd ? ad - bd : a.createdAt.getTime() - b.createdAt.getTime();
  });

  const nodes = await loadOtsNodes(db, tenantId, { productId });
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const releaseIds = releases.map((r) => r.id);
  const links = releaseIds.length
    ? await db
        .select({
          softwareVersionId: schema.softwareVersionLinks.softwareVersionId,
          versionId: schema.architectureNodeVersions.id,
          architectureNodeId: schema.architectureNodeVersions.architectureNodeId,
          version: schema.architectureNodeVersions.version,
          patchLevel: schema.architectureNodeVersions.patchLevel,
        })
        .from(schema.softwareVersionLinks)
        .innerJoin(schema.architectureNodeVersions, eq(schema.softwareVersionLinks.entityId, schema.architectureNodeVersions.id))
        .where(
          and(
            eq(schema.softwareVersionLinks.tenantId, tenantId),
            eq(schema.softwareVersionLinks.entityType, "architecture_node_version"),
            inArray(schema.softwareVersionLinks.softwareVersionId, releaseIds),
          ),
        )
    : [];

  return releases.map((release) => {
    const byNode = new Map<string, ReleaseComponentVersion[]>();
    for (const l of links) {
      if (l.softwareVersionId !== release.id || !nodeById.has(l.architectureNodeId)) continue;
      const list = byNode.get(l.architectureNodeId) ?? [];
      list.push({ id: l.versionId, version: l.version, patchLevel: l.patchLevel });
      byNode.set(l.architectureNodeId, list);
    }
    return { release, nodeById, byNode };
  });
}

function versionLabel(versions: ReleaseComponentVersion[]): string {
  return versions
    .map((v) => (v.patchLevel ? `${v.version} (${v.patchLevel})` : v.version))
    .sort()
    .join(", ");
}

/** Per product release (oldest first): the OTS components shipped, and what was added,
 * removed or changed since the previous release, with the new versions' assessments. */
export async function getOtsReleaseChanges(db: TenantTx, tenantId: string, productId: string) {
  const perRelease = await loadReleaseComponents(db, tenantId, productId);
  const changedVersionIds = perRelease.flatMap((r) => [...r.byNode.values()].flat().map((v) => v.id));
  const assessments = await loadVersionAssessments(db, tenantId, [...new Set(changedVersionIds)]);

  let previous: Map<string, ReleaseComponentVersion[]> = new Map();
  return perRelease.map(({ release, nodeById, byNode }) => {
    const ref = (nodeId: string) => {
      const n = nodeById.get(nodeId)!;
      return { id: n.id, displayId: n.displayId, title: n.title, supplier: n.supplier };
    };
    const components = [...byNode.entries()].map(([nodeId, versions]) => ({ ...ref(nodeId), version: versionLabel(versions) }));
    const added = components.filter((c) => !previous.has(c.id));
    const removed = [...previous.entries()]
      .filter(([nodeId]) => !byNode.has(nodeId))
      .map(([nodeId, versions]) => ({ ...ref(nodeId), version: versionLabel(versions) }));
    const changed = [...byNode.entries()]
      .filter(([nodeId, versions]) => {
        const before = previous.get(nodeId);
        return before && versionLabel(before) !== versionLabel(versions);
      })
      .map(([nodeId, versions]) => {
        const beforeIds = new Set(previous.get(nodeId)!.map((v) => v.id));
        const newVersions = versions.filter((v) => !beforeIds.has(v.id));
        return {
          ...ref(nodeId),
          from: versionLabel(previous.get(nodeId)!),
          to: versionLabel(versions),
          assessments: newVersions
            .map((v) => {
              const a = assessments.get(v.id);
              return a ? { version: v.version, ...a } : null;
            })
            .filter((a): a is NonNullable<typeof a> => a !== null),
        };
      });
    previous = byNode;
    return {
      release: {
        id: release.id,
        versionNumber: release.versionNumber,
        releaseDate: release.releaseDate,
      },
      components,
      added,
      removed,
      changed,
    };
  });
}

/** A known issue with no affected versions ticked affects every version. */
function anomalyAffects(anomaly: Pick<OtsAnomalyView, "affectedVersionIds">, shipped: ReleaseComponentVersion[]): boolean {
  if (anomaly.affectedVersionIds.length === 0) return shipped.length > 0;
  return shipped.some((v) => anomaly.affectedVersionIds.includes(v.id));
}

/** Per product release (oldest first): every known issue affecting an OTS version shipped
 * in it, whatever its outcome. */
export async function listUnresolvedOtsAnomaliesByRelease(db: TenantTx, tenantId: string, productId: string) {
  const perRelease = await loadReleaseComponents(db, tenantId, productId);
  const nodeIds = [...new Set(perRelease.flatMap((r) => [...r.byNode.keys()]))];
  const anomaliesByNode = await loadAnomalies(db, tenantId, nodeIds);
  return perRelease.map(({ release, byNode, nodeById }) => ({
    release: { id: release.id, versionNumber: release.versionNumber, releaseDate: release.releaseDate },
    anomalies: [...byNode].flatMap(([nodeId, shipped]) => {
      const node = nodeById.get(nodeId)!;
      const component = { id: node.id, displayId: node.displayId, title: node.title, supplier: node.supplier, version: versionLabel(shipped) };
      return (anomaliesByNode.get(nodeId) ?? []).filter((a) => anomalyAffects(a, shipped)).map((a) => ({ component, ...a }));
    }),
  }));
}
