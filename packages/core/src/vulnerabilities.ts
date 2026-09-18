import { type TenantTx, schema } from "@galm/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getArchitectureNode } from "./architecture";
import { DomainError } from "./errors";

/** What's needed to build an NVD search query for an OTS node - a subset of
 * ArchitectureNodeView, kept minimal so this stays a pure function callers can test
 * without constructing a full node view. */
export interface ScanQueryNode {
  cpe: string | null;
  supplier: string | null;
  title: string;
  version: string | null;
}

/** Prefers an exact CPE match when the node has one (far more precise); falls back to a
 * free-text keyword built from supplier+title+version. Returns null when neither is
 * available - nothing usable to search NVD with yet. */
export function buildScanQuery(node: ScanQueryNode): { matchType: "cpe" | "keyword"; query: string } | null {
  if (node.cpe?.trim()) {
    return { matchType: "cpe", query: node.cpe.trim() };
  }
  const keyword = [node.supplier, node.title, node.version]
    .map((part) => part?.trim())
    .filter((part): part is string => !!part)
    .join(" ")
    .trim();
  if (!keyword) return null;
  return { matchType: "keyword", query: keyword };
}

/** Shape of one NVD-reported CVE, as needed to persist a finding - kept local to this
 * module (not importing @galm/integrations-nvd's NvdFinding type) so packages/core has
 * no dependency on any specific vulnerability data source. */
export interface ScannedFinding {
  cveId: string;
  description: string;
  cvssScore: number | null;
  cvssVersion: string | null;
  severity: string | null;
  publishedAt: Date;
  lastModifiedAt: Date;
  sourceUrl: string;
}

/** Persists the outcome of one scan attempt: always writes a vulnerability_scans row
 * (success or failure), and on success upserts every reported finding into
 * vulnerability_findings (refreshing cached fields + lastSeenAt + lastScanId on
 * conflict, leaving firstSeenAt untouched) and writes an audit-log entry. The caller
 * (packages/integrations/nvd) is responsible for actually calling the NVD API - this
 * function only ever touches the database. */
export async function recordScanResult(
  db: TenantTx,
  params: {
    tenantId: string;
    architectureNodeId: string;
    /** Which version was active when this scan ran - stamped onto the scan row so a
     * finding can later be told apart as "confirmed under the current version" vs. "only
     * ever seen under a version that's since been superseded" (see
     * getVulnerabilitiesForNode's confirmedUnderCurrentVersion). */
    architectureNodeVersionId: string | null;
    triggeredBy: string;
    matchType: "cpe" | "keyword";
    query: string;
  } & ({ ok: true; findings: ScannedFinding[] } | { ok: false; errorMessage: string }),
): Promise<{ scanId: string; matchType: "cpe" | "keyword"; resultCount: number; newFindingCount: number }> {
  const [scan] = await db
    .insert(schema.vulnerabilityScans)
    .values({
      tenantId: params.tenantId,
      architectureNodeId: params.architectureNodeId,
      architectureNodeVersionId: params.architectureNodeVersionId,
      triggeredBy: params.triggeredBy,
      query: params.query,
      matchType: params.matchType,
      resultCount: params.ok ? params.findings.length : 0,
      status: params.ok ? "completed" : "failed",
      errorMessage: params.ok ? null : params.errorMessage,
    })
    .returning();
  if (!scan) throw new DomainError("failed to record vulnerability scan");

  if (!params.ok) {
    return { scanId: scan.id, matchType: params.matchType, resultCount: 0, newFindingCount: 0 };
  }

  let newFindingCount = 0;
  for (const finding of params.findings) {
    const [row] = await db
      .insert(schema.vulnerabilityFindings)
      .values({
        tenantId: params.tenantId,
        architectureNodeId: params.architectureNodeId,
        cveId: finding.cveId,
        description: finding.description,
        cvssScore: finding.cvssScore,
        cvssVersion: finding.cvssVersion,
        severity: finding.severity,
        publishedAt: finding.publishedAt,
        lastModifiedAt: finding.lastModifiedAt,
        sourceUrl: finding.sourceUrl,
        lastScanId: scan.id,
      })
      .onConflictDoUpdate({
        target: [schema.vulnerabilityFindings.architectureNodeId, schema.vulnerabilityFindings.cveId],
        set: {
          description: finding.description,
          cvssScore: finding.cvssScore,
          cvssVersion: finding.cvssVersion,
          severity: finding.severity,
          publishedAt: finding.publishedAt,
          lastModifiedAt: finding.lastModifiedAt,
          sourceUrl: finding.sourceUrl,
          lastSeenAt: new Date(),
          lastScanId: scan.id,
        },
      })
      .returning({ firstSeenAt: schema.vulnerabilityFindings.firstSeenAt, lastSeenAt: schema.vulnerabilityFindings.lastSeenAt });
    if (row && row.firstSeenAt.getTime() === row.lastSeenAt.getTime()) newFindingCount++;
  }

  return { scanId: scan.id, matchType: params.matchType, resultCount: params.findings.length, newFindingCount };
}

/** Two independent toggles, not a single mutually-exclusive status - a finding can be a
 * real, non-false-positive CVE that still doesn't affect this product (e.g. an
 * unreachable code path), which a single enum can't represent. Defaults are the
 * conservative/safe assumption (affectsProduct=true, falsePositive=false: assume real and
 * applicable), so a rationale is only required when the caller asserts the opposite of a
 * default - affectsProduct=false or falsePositive=true - not when merely confirming it. */
export async function setVulnerabilityAnnotation(
  db: TenantTx,
  params: {
    tenantId: string;
    architectureNodeId: string;
    cveId: string;
    assessed: boolean;
    affectsProduct: boolean;
    falsePositive: boolean;
    rationale: string;
    /** Always optional, unlike rationale - never required regardless of the toggle
     * values (see the column's schema comment). */
    notes?: string | null;
    annotatedBy: string;
  },
) {
  const rationale = params.rationale.trim();
  const needsRationale = !params.affectsProduct || params.falsePositive;
  if (needsRationale && !rationale) {
    throw new DomainError(
      "a rationale is required when marking a finding as not affecting the product or as a false positive",
    );
  }
  const notes = params.notes?.trim() || null;
  await db
    .insert(schema.vulnerabilityAnnotations)
    .values({
      tenantId: params.tenantId,
      architectureNodeId: params.architectureNodeId,
      cveId: params.cveId,
      assessed: params.assessed,
      affectsProduct: params.affectsProduct,
      falsePositive: params.falsePositive,
      rationale,
      notes,
      annotatedBy: params.annotatedBy,
    })
    .onConflictDoUpdate({
      target: [schema.vulnerabilityAnnotations.architectureNodeId, schema.vulnerabilityAnnotations.cveId],
      set: {
        assessed: params.assessed,
        affectsProduct: params.affectsProduct,
        falsePositive: params.falsePositive,
        rationale,
        notes,
        annotatedBy: params.annotatedBy,
        annotatedAt: new Date(),
      },
    });
}

export async function getVulnerabilitiesForNode(db: TenantTx, tenantId: string, architectureNodeId: string) {
  // Confirms the node exists under this tenant (RLS-scoped) before reading scan/finding/
  // annotation tables - those are otherwise queried by tenantId+architectureNodeId alone
  // with no FK back to a node the caller is proven to own, so without this check a
  // syntactically valid but foreign nodeId would just come back empty rather than erroring.
  // Also gives us the node's current version, needed for the staleness check below.
  const { node } = await getArchitectureNode(db, tenantId, architectureNodeId);
  const currentVersionId = node.currentVersion?.id ?? null;

  const [latestScan] = await db
    .select()
    .from(schema.vulnerabilityScans)
    .where(
      and(
        eq(schema.vulnerabilityScans.tenantId, tenantId),
        eq(schema.vulnerabilityScans.architectureNodeId, architectureNodeId),
      ),
    )
    .orderBy(desc(schema.vulnerabilityScans.createdAt))
    .limit(1);

  // Left-joined to the finding's last confirming scan so we can tell "seen under the
  // node's current version" apart from "only ever seen under an earlier one" - see
  // confirmedUnderCurrentVersion below. No new column needed on findings themselves.
  const findings = await db
    .select({
      tenantId: schema.vulnerabilityFindings.tenantId,
      architectureNodeId: schema.vulnerabilityFindings.architectureNodeId,
      cveId: schema.vulnerabilityFindings.cveId,
      description: schema.vulnerabilityFindings.description,
      cvssScore: schema.vulnerabilityFindings.cvssScore,
      cvssVersion: schema.vulnerabilityFindings.cvssVersion,
      severity: schema.vulnerabilityFindings.severity,
      publishedAt: schema.vulnerabilityFindings.publishedAt,
      lastModifiedAt: schema.vulnerabilityFindings.lastModifiedAt,
      sourceUrl: schema.vulnerabilityFindings.sourceUrl,
      firstSeenAt: schema.vulnerabilityFindings.firstSeenAt,
      lastSeenAt: schema.vulnerabilityFindings.lastSeenAt,
      lastScanId: schema.vulnerabilityFindings.lastScanId,
      lastScanVersionId: schema.vulnerabilityScans.architectureNodeVersionId,
    })
    .from(schema.vulnerabilityFindings)
    .leftJoin(schema.vulnerabilityScans, eq(schema.vulnerabilityFindings.lastScanId, schema.vulnerabilityScans.id))
    .where(
      and(
        eq(schema.vulnerabilityFindings.tenantId, tenantId),
        eq(schema.vulnerabilityFindings.architectureNodeId, architectureNodeId),
      ),
    )
    .orderBy(desc(schema.vulnerabilityFindings.cvssScore));

  const annotations = await db
    .select()
    .from(schema.vulnerabilityAnnotations)
    .where(
      and(
        eq(schema.vulnerabilityAnnotations.tenantId, tenantId),
        eq(schema.vulnerabilityAnnotations.architectureNodeId, architectureNodeId),
      ),
    );
  const annotationByCve = new Map(annotations.map((a) => [a.cveId, a]));

  return {
    latestScan: latestScan ?? null,
    findings: findings.map(({ lastScanVersionId, ...finding }) => {
      const annotation = annotationByCve.get(finding.cveId) ?? null;
      return {
        ...finding,
        isNew: annotation === null,
        assessed: annotation?.assessed ?? false,
        // Defaults mirror the conservative assumption an unannotated finding gets: real
        // and applicable, so an absent annotation reads the same as an explicit "confirmed".
        affectsProduct: annotation?.affectsProduct ?? true,
        falsePositive: annotation?.falsePositive ?? false,
        rationale: annotation?.rationale ?? null,
        notes: annotation?.notes ?? null,
        annotatedAt: annotation?.annotatedAt ?? null,
        // No current version recorded yet -> nothing to be stale relative to, so don't
        // badge anything. Otherwise: was this finding's last confirming scan the same
        // version the node is on right now?
        confirmedUnderCurrentVersion: currentVersionId === null || lastScanVersionId === currentVersionId,
      };
    }),
  };
}

/** Per-version row for the OTS view: version identity plus the counts and latest-scan
 * info for whichever findings were last confirmed while this version was current (see
 * getOtsSummaryForProduct's docstring). One node can have many of these - a forerunner
 * of the future "releases" concept (which will let a specific past version be pinned
 * and filtered to), so this stays a flat list per node rather than collapsing to just
 * the current one at the data layer - the UI decides whether to show history or not. */
export interface OtsVersionSummary {
  id: string;
  version: string;
  cpe: string | null;
  createdAt: Date;
  isCurrent: boolean;
  latestScan: (typeof schema.vulnerabilityScans.$inferSelect) | null;
  counts: { total: number; new: number; confirmed: number; notApplicable: number; falsePositive: number };
}

function emptyOtsCounts() {
  return { total: 0, new: 0, confirmed: 0, notApplicable: 0, falsePositive: 0 };
}

/** One row per OTS node, each carrying its FULL version history (not just the current
 * one) - see OtsVersionSummary. A finding's counts are attributed to whichever version
 * last confirmed it: `finding.lastScanId` points at the scan that last saw it, and that
 * scan's `architectureNodeVersionId` says which version was current when that happened.
 * A CVE reconfirmed under a newer version moves to that version's bucket and drops out of
 * the old one - the same "confirmedUnderCurrentVersion" logic getVulnerabilitiesForNode
 * uses for a single node, generalized across every version a node has ever had. */
export async function getOtsSummaryForProduct(db: TenantTx, tenantId: string, productId: string, levelId: string) {
  const nodeRows = await db
    .select({
      id: schema.architectureNodes.id,
      title: schema.architectureNodes.title,
      supplier: schema.architectureNodes.supplier,
      sequenceNumber: schema.architectureNodes.sequenceNumber,
      currentVersionId: schema.architectureNodes.currentVersionId,
    })
    .from(schema.architectureNodes)
    .where(
      and(
        eq(schema.architectureNodes.tenantId, tenantId),
        eq(schema.architectureNodes.productId, productId),
        eq(schema.architectureNodes.levelId, levelId),
        eq(schema.architectureNodes.kind, "ots"),
      ),
    );
  if (nodeRows.length === 0) return [];
  const nodeIds = nodeRows.map((n) => n.id);

  const [versionRows, findingRows, annotationRows, scanRows] = await Promise.all([
    db
      .select()
      .from(schema.architectureNodeVersions)
      .where(
        and(eq(schema.architectureNodeVersions.tenantId, tenantId), inArray(schema.architectureNodeVersions.architectureNodeId, nodeIds)),
      )
      .orderBy(desc(schema.architectureNodeVersions.createdAt)),
    db
      .select({
        architectureNodeId: schema.vulnerabilityFindings.architectureNodeId,
        cveId: schema.vulnerabilityFindings.cveId,
        lastScanId: schema.vulnerabilityFindings.lastScanId,
      })
      .from(schema.vulnerabilityFindings)
      .where(
        and(eq(schema.vulnerabilityFindings.tenantId, tenantId), inArray(schema.vulnerabilityFindings.architectureNodeId, nodeIds)),
      ),
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
      .select()
      .from(schema.vulnerabilityScans)
      .where(and(eq(schema.vulnerabilityScans.tenantId, tenantId), inArray(schema.vulnerabilityScans.architectureNodeId, nodeIds)))
      .orderBy(desc(schema.vulnerabilityScans.createdAt)),
  ]);

  const scanById = new Map(scanRows.map((s) => [s.id, s]));
  const annotationByPair = new Map(annotationRows.map((a) => [`${a.architectureNodeId}:${a.cveId}`, a] as const));

  // scanRows is already sorted newest-first, so the first one seen per (node, version)
  // pair wins.
  const latestScanByNodeVersion = new Map<string, (typeof scanRows)[number]>();
  for (const scan of scanRows) {
    if (!scan.architectureNodeVersionId) continue;
    const key = `${scan.architectureNodeId}:${scan.architectureNodeVersionId}`;
    if (!latestScanByNodeVersion.has(key)) latestScanByNodeVersion.set(key, scan);
  }

  const countsByNodeVersion = new Map<string, OtsVersionSummary["counts"]>();
  for (const finding of findingRows) {
    const scan = finding.lastScanId ? scanById.get(finding.lastScanId) : undefined;
    const versionId = scan?.architectureNodeVersionId;
    if (!versionId) continue; // no version on record for this finding's confirming scan
    const key = `${finding.architectureNodeId}:${versionId}`;
    const bucket = countsByNodeVersion.get(key) ?? emptyOtsCounts();
    countsByNodeVersion.set(key, bucket);
    bucket.total++;
    const annotation = annotationByPair.get(`${finding.architectureNodeId}:${finding.cveId}`);
    if (!annotation) bucket.new++;
    else if (annotation.falsePositive) bucket.falsePositive++;
    else if (!annotation.affectsProduct) bucket.notApplicable++;
    else bucket.confirmed++;
  }

  const versionsByNode = new Map<string, (typeof versionRows)[number][]>();
  for (const v of versionRows) {
    const list = versionsByNode.get(v.architectureNodeId) ?? [];
    list.push(v);
    versionsByNode.set(v.architectureNodeId, list);
  }

  return nodeRows
    .sort((a, b) => a.sequenceNumber - b.sequenceNumber)
    .map((node) => {
      const versions: OtsVersionSummary[] = (versionsByNode.get(node.id) ?? []).map((v) => ({
        id: v.id,
        version: v.version,
        cpe: v.cpe,
        createdAt: v.createdAt,
        isCurrent: v.id === node.currentVersionId,
        latestScan: latestScanByNodeVersion.get(`${node.id}:${v.id}`) ?? null,
        counts: countsByNodeVersion.get(`${node.id}:${v.id}`) ?? emptyOtsCounts(),
      }));
      return {
        node: { id: node.id, title: node.title, supplier: node.supplier, sequenceNumber: node.sequenceNumber },
        versions,
      };
    });
}
