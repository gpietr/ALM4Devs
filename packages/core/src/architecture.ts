import { type TenantTx, schema } from "@galm/db";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { getArchitectureLevel } from "./architecture-levels";
import { writeAuditLog } from "./audit";
import { DomainError } from "./errors";
import { formatItemId } from "./item-id";
import { decrementSequenceCounterIfTip, nextSequenceNumber } from "./level-sequences";

export const ARCHITECTURE_KINDS = ["software_item", "software_unit", "ots"] as const;
export type ArchitectureKind = (typeof ARCHITECTURE_KINDS)[number];

type ArchitectureNodeRow = typeof schema.architectureNodes.$inferSelect;

export const OTS_VERSION_SUPPORT_STATUSES = ["in_use", "allowed", "retired"] as const;
export type OtsVersionSupportStatus = (typeof OTS_VERSION_SUPPORT_STATUSES)[number];

export interface ArchitectureNodeVersionView {
  id: string;
  version: string;
  cpe: string | null;
  releaseDate: Date | null;
  patchLevel: string | null;
  upgradeDesignation: string | null;
  releaseNotesUrl: string | null;
  supportStatus: string;
  createdAt: Date;
}

/** Every column of ArchitectureNodeVersionView, shared by each query reading version rows. */
const VERSION_COLUMNS = {
  id: schema.architectureNodeVersions.id,
  version: schema.architectureNodeVersions.version,
  cpe: schema.architectureNodeVersions.cpe,
  releaseDate: schema.architectureNodeVersions.releaseDate,
  patchLevel: schema.architectureNodeVersions.patchLevel,
  upgradeDesignation: schema.architectureNodeVersions.upgradeDesignation,
  releaseNotesUrl: schema.architectureNodeVersions.releaseNotesUrl,
  supportStatus: schema.architectureNodeVersions.supportStatus,
  createdAt: schema.architectureNodeVersions.createdAt,
};

export interface ArchitectureNodeView {
  id: string;
  kind: ArchitectureKind;
  parentId: string | null;
  sequenceNumber: number;
  title: string;
  description: string;
  supplier: string | null;
  /** The OTS item's current recorded version, or null if none has been recorded yet (or
   * this isn't an OTS node). See architecture_node_versions - version identity is
   * append-only history, not a flat mutable field, so this is always the latest row rather
   * than something edited in place. */
  currentVersion: ArchitectureNodeVersionView | null;
  createdAt: Date;
  updatedAt: Date;
  levelCode: string;
  displayId: string;
  mermaidId: string;
  children: ArchitectureNodeView[];
}

/** Mermaid-safe id for a display id like SYSARCH-1 → SYSARCH_1. Hyphens in unquoted
 * mermaid ids parse as minus. Level codes are uppercase alphanumeric (normalizeLevelCode),
 * so the underscore is unambiguous. */
export function mermaidNodeId(code: string, sequenceNumber: number): string {
  return `${code}_${sequenceNumber}`;
}

function asKind(kind: string): ArchitectureKind {
  if (kind === "software_item" || kind === "software_unit" || kind === "ots") return kind;
  throw new DomainError(`unknown architecture kind '${kind}'`);
}

function displayOf(code: string, sequenceNumber: number) {
  return {
    levelCode: code,
    displayId: formatItemId(code, sequenceNumber),
    mermaidId: mermaidNodeId(code, sequenceNumber),
  };
}

function escapeMermaidLabel(title: string): string {
  const cleaned = title
    .replace(/[`"<>#\[\]\n;]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "untitled";
}

/** Visualization-only. Local `n1` ids (not display ids) so mermaid never treats a
 * level-code prefix as syntax. Empty trees return "" so the UI can skip render. */
export function generateMermaid(
  nodes: Array<{ id: string; parentId: string | null; sequenceNumber: number; title: string }>,
  levelCode: string,
): string {
  if (nodes.length === 0) return "";
  const localId = new Map(nodes.map((n, i) => [n.id, `n${i + 1}`]));
  const lines = ["flowchart TB"];
  for (const n of nodes) {
    const label = `${formatItemId(levelCode, n.sequenceNumber)} ${escapeMermaidLabel(n.title)}`;
    lines.push(`  ${localId.get(n.id)}["${label}"]`);
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const n of nodes) {
    if (!n.parentId) continue;
    const parent = byId.get(n.parentId);
    if (!parent) continue;
    lines.push(`  ${localId.get(parent.id)} --> ${localId.get(n.id)}`);
  }
  return lines.join("\n");
}

function nest(
  rows: ArchitectureNodeRow[],
  levelCode: string,
  versionsByNodeId: Map<string, ArchitectureNodeVersionView>,
): ArchitectureNodeView[] {
  const views = new Map<string, ArchitectureNodeView>();
  for (const row of rows) {
    views.set(row.id, {
      id: row.id,
      kind: asKind(row.kind),
      parentId: row.parentId,
      sequenceNumber: row.sequenceNumber,
      title: row.title,
      description: row.description,
      supplier: row.supplier,
      currentVersion: versionsByNodeId.get(row.id) ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...displayOf(levelCode, row.sequenceNumber),
      children: [],
    });
  }
  const roots: ArchitectureNodeView[] = [];
  for (const view of views.values()) {
    if (!view.parentId) {
      roots.push(view);
      continue;
    }
    const parent = views.get(view.parentId);
    if (parent) parent.children.push(view);
    else roots.push(view);
  }
  const bySeq = (a: ArchitectureNodeView, b: ArchitectureNodeView) => a.sequenceNumber - b.sequenceNumber;
  function sortTree(nodes: ArchitectureNodeView[]) {
    nodes.sort(bySeq);
    for (const n of nodes) sortTree(n.children);
  }
  sortTree(roots);
  return roots;
}

async function listRows(db: TenantTx, tenantId: string, productId: string, levelId: string) {
  return db
    .select()
    .from(schema.architectureNodes)
    .where(
      and(
        eq(schema.architectureNodes.tenantId, tenantId),
        eq(schema.architectureNodes.productId, productId),
        eq(schema.architectureNodes.levelId, levelId),
      ),
    )
    .orderBy(asc(schema.architectureNodes.sequenceNumber));
}

async function getRow(db: TenantTx, tenantId: string, id: string): Promise<ArchitectureNodeRow> {
  const [row] = await db
    .select()
    .from(schema.architectureNodes)
    .where(and(eq(schema.architectureNodes.id, id), eq(schema.architectureNodes.tenantId, tenantId)));
  if (!row) throw new DomainError(`architecture node ${id} not found`);
  return row;
}

/** Batched "current version" lookup for a set of nodes - joins each node's
 * currentVersionId to its architecture_node_versions row in one query, rather than N+1.
 * Nodes with no version recorded yet (or non-OTS nodes, which never have one) simply have
 * no entry in the returned map. */
async function loadCurrentVersions(
  db: TenantTx,
  tenantId: string,
  nodeIds: string[],
): Promise<Map<string, ArchitectureNodeVersionView>> {
  const map = new Map<string, ArchitectureNodeVersionView>();
  if (nodeIds.length === 0) return map;
  const rows = await db
    .select({ nodeId: schema.architectureNodes.id, ...VERSION_COLUMNS })
    .from(schema.architectureNodes)
    .innerJoin(
      schema.architectureNodeVersions,
      eq(schema.architectureNodes.currentVersionId, schema.architectureNodeVersions.id),
    )
    .where(and(eq(schema.architectureNodes.tenantId, tenantId), inArray(schema.architectureNodes.id, nodeIds)));
  for (const { nodeId, ...version } of rows) {
    map.set(nodeId, version);
  }
  return map;
}

/** Full version history for one OTS node, newest first - for the node detail page's
 * "Version history" list. Rows are immutable and never deleted (see
 * architecture_node_versions' schema comment), so this is a permanent record. */
export async function listArchitectureNodeVersions(
  db: TenantTx,
  tenantId: string,
  architectureNodeId: string,
): Promise<ArchitectureNodeVersionView[]> {
  return db
    .select(VERSION_COLUMNS)
    .from(schema.architectureNodeVersions)
    .where(
      and(
        eq(schema.architectureNodeVersions.tenantId, tenantId),
        eq(schema.architectureNodeVersions.architectureNodeId, architectureNodeId),
      ),
    )
    .orderBy(desc(schema.architectureNodeVersions.createdAt));
}

/** Loads one specific version row, scoped to both tenant and node - used when scanning a
 * version other than the current one (see packages/integrations/nvd/src/scan.ts), so an
 * arbitrary versionId can't be pointed at a version belonging to a different node or
 * tenant. */
export async function getArchitectureNodeVersion(
  db: TenantTx,
  tenantId: string,
  architectureNodeId: string,
  versionId: string,
): Promise<ArchitectureNodeVersionView> {
  const [row] = await db
    .select(VERSION_COLUMNS)
    .from(schema.architectureNodeVersions)
    .where(
      and(
        eq(schema.architectureNodeVersions.tenantId, tenantId),
        eq(schema.architectureNodeVersions.architectureNodeId, architectureNodeId),
        eq(schema.architectureNodeVersions.id, versionId),
      ),
    );
  if (!row) throw new DomainError(`version ${versionId} not found for this node`);
  return row;
}

function assertContainment(childKind: ArchitectureKind, parent: ArchitectureNodeRow | null) {
  if (!parent) {
    if (childKind !== "software_item") {
      throw new DomainError("only a software item can sit at the root of an architecture level");
    }
    return;
  }
  if (parent.kind === "ots") {
    throw new DomainError("an OTS item cannot have children");
  }
  if (parent.kind === "software_unit" && childKind !== "ots") {
    throw new DomainError("a software unit may only contain OTS items");
  }
}

function wouldCycle(rows: ArchitectureNodeRow[], childId: string, parentId: string | null): boolean {
  if (!parentId) return false;
  if (parentId === childId) return true;
  const byId = new Map(rows.map((r) => [r.id, r]));
  let current: ArchitectureNodeRow | undefined = byId.get(parentId);
  const seen = new Set<string>();
  while (current) {
    if (current.id === childId) return true;
    if (seen.has(current.id)) return true;
    seen.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return false;
}

async function resolveParent(
  db: TenantTx,
  params: {
    tenantId: string;
    productId: string;
    levelId: string;
    childKind: ArchitectureKind;
    childId?: string;
    parentId: string | null;
    rows?: ArchitectureNodeRow[];
  },
): Promise<ArchitectureNodeRow | null> {
  if (!params.parentId) {
    assertContainment(params.childKind, null);
    return null;
  }
  const parent = await getRow(db, params.tenantId, params.parentId);
  if (parent.productId !== params.productId) {
    throw new DomainError("parent must belong to the same product");
  }
  if (parent.levelId !== params.levelId) {
    throw new DomainError("parent must belong to the same architecture level");
  }
  assertContainment(params.childKind, parent);
  if (params.childId) {
    const rows = params.rows ?? (await listRows(db, params.tenantId, params.productId, params.levelId));
    if (wouldCycle(rows, params.childId, params.parentId)) {
      throw new DomainError("parent would create a cycle");
    }
  }
  return parent;
}

function descendantIds(rows: ArchitectureNodeRow[], rootId: string): Set<string> {
  const childrenOf = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.parentId) continue;
    const list = childrenOf.get(row.parentId) ?? [];
    list.push(row.id);
    childrenOf.set(row.parentId, list);
  }
  const out = new Set<string>();
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    for (const childId of childrenOf.get(id) ?? []) {
      if (out.has(childId)) continue;
      out.add(childId);
      stack.push(childId);
    }
  }
  return out;
}

export async function listTree(db: TenantTx, tenantId: string, productId: string, levelId: string) {
  const level = await getArchitectureLevel(db, tenantId, levelId);
  const rows = await listRows(db, tenantId, productId, levelId);
  const versionsByNodeId = await loadCurrentVersions(
    db,
    tenantId,
    rows.map((r) => r.id),
  );
  return {
    level,
    tree: nest(rows, level.code, versionsByNodeId),
    mermaid: generateMermaid(rows, level.code),
    nodes: rows.map((row) => ({
      ...row,
      kind: asKind(row.kind),
      currentVersion: versionsByNodeId.get(row.id) ?? null,
      ...displayOf(level.code, row.sequenceNumber),
    })),
  };
}

export async function listAllByProduct(db: TenantTx, tenantId: string, productId: string) {
  return db
    .select({
      id: schema.architectureNodes.id,
      title: schema.architectureNodes.title,
      kind: schema.architectureNodes.kind,
      sequenceNumber: schema.architectureNodes.sequenceNumber,
      levelName: schema.levels.name,
      levelCode: schema.levels.code,
    })
    .from(schema.architectureNodes)
    .innerJoin(schema.levels, eq(schema.architectureNodes.levelId, schema.levels.id))
    .where(and(eq(schema.architectureNodes.tenantId, tenantId), eq(schema.architectureNodes.productId, productId)))
    .orderBy(asc(schema.levels.sortOrder), asc(schema.architectureNodes.sequenceNumber));
}

export async function getArchitectureNode(db: TenantTx, tenantId: string, id: string) {
  const row = await getRow(db, tenantId, id);
  const level = await getArchitectureLevel(db, tenantId, row.levelId);
  const rows = await listRows(db, tenantId, row.productId, row.levelId);
  const kind = asKind(row.kind);
  const blocked = descendantIds(rows, row.id);
  blocked.add(row.id);

  const parent = row.parentId ? rows.find((r) => r.id === row.parentId) ?? null : null;
  const children = rows.filter((r) => r.parentId === row.id);

  const parentOptions = rows
    .filter((candidate) => {
      if (blocked.has(candidate.id)) return false;
      try {
        assertContainment(kind, candidate);
      } catch {
        return false;
      }
      return true;
    })
    .map((candidate) => ({
      id: candidate.id,
      kind: asKind(candidate.kind),
      title: candidate.title,
      ...displayOf(level.code, candidate.sequenceNumber),
    }));

  const versionsByNodeId = await loadCurrentVersions(db, tenantId, [row.id]);

  return {
    node: {
      ...row,
      kind,
      currentVersion: versionsByNodeId.get(row.id) ?? null,
      ...displayOf(level.code, row.sequenceNumber),
    },
    parent: parent
      ? { id: parent.id, kind: asKind(parent.kind), title: parent.title, ...displayOf(level.code, parent.sequenceNumber) }
      : null,
    children: children.map((c) => ({
      id: c.id,
      kind: asKind(c.kind),
      title: c.title,
      ...displayOf(level.code, c.sequenceNumber),
    })),
    parentOptions,
    canBeRoot: kind === "software_item",
    requirementLinks: await listRequirementLinksForNode(db, tenantId, row.id),
    testCaseLinks: await listTestCaseLinksForNode(db, tenantId, row.id),
    versionHistory: kind === "ots" ? await listArchitectureNodeVersions(db, tenantId, row.id) : [],
  };
}

export async function createArchitectureNode(
  db: TenantTx,
  params: {
    tenantId: string;
    productId: string;
    levelId: string;
    kind: ArchitectureKind;
    parentId?: string | null;
    title: string;
    description?: string;
    supplier?: string | null;
    version?: string | null;
    cpe?: string | null;
    createdBy: string;
  },
) {
  const level = await getArchitectureLevel(db, params.tenantId, params.levelId);
  const kind = asKind(params.kind);
  await resolveParent(db, {
    tenantId: params.tenantId,
    productId: params.productId,
    levelId: params.levelId,
    childKind: kind,
    parentId: params.parentId ?? null,
  });

  if (kind !== "ots" && (params.supplier || params.version || params.cpe)) {
    throw new DomainError("supplier, version, and cpe are only valid on OTS items");
  }
  if (kind === "ots" && params.cpe?.trim() && !params.version?.trim()) {
    throw new DomainError("a version is required when providing a CPE");
  }

  const sequenceNumber = await nextSequenceNumber(db, params.tenantId, params.productId, params.levelId);
  const [node] = await db
    .insert(schema.architectureNodes)
    .values({
      tenantId: params.tenantId,
      productId: params.productId,
      levelId: params.levelId,
      kind,
      parentId: params.parentId ?? null,
      sequenceNumber,
      title: params.title,
      description: params.description ?? "",
      supplier: kind === "ots" ? params.supplier?.trim() || null : null,
      createdBy: params.createdBy,
    })
    .returning();
  if (!node) throw new DomainError("failed to create architecture node");

  let currentVersion: ArchitectureNodeVersionView | null = null;
  if (kind === "ots" && params.version?.trim()) {
    const [versionRow] = await db
      .insert(schema.architectureNodeVersions)
      .values({
        tenantId: params.tenantId,
        architectureNodeId: node.id,
        version: params.version.trim(),
        cpe: params.cpe?.trim() || null,
        createdBy: params.createdBy,
      })
      .returning();
    if (!versionRow) throw new DomainError("failed to record initial version");
    await db
      .update(schema.architectureNodes)
      .set({ currentVersionId: versionRow.id })
      .where(eq(schema.architectureNodes.id, node.id));
    currentVersion = versionRow;
  }

  const ids = displayOf(level.code, sequenceNumber);
  await writeAuditLog(db, {
    tenantId: params.tenantId,
    actorUserId: params.createdBy,
    action: "architecture.created",
    entityType: "architecture_node",
    entityId: node.id,
    payload: { kind, title: params.title, displayId: ids.displayId, parentId: node.parentId },
  });

  return { node: { ...node, kind, currentVersion, currentVersionId: currentVersion?.id ?? null, ...ids } };
}

export async function updateArchitectureNode(
  db: TenantTx,
  params: {
    tenantId: string;
    id: string;
    title: string;
    description?: string;
    parentId?: string | null;
    supplier?: string | null;
    requirementIds?: string[];
    testCaseIds?: string[];
    actorUserId: string;
  },
) {
  const existing = await getRow(db, params.tenantId, params.id);
  const kind = asKind(existing.kind);
  const rows = await listRows(db, params.tenantId, existing.productId, existing.levelId);
  const parentId = params.parentId === undefined ? existing.parentId : params.parentId;
  await resolveParent(db, {
    tenantId: params.tenantId,
    productId: existing.productId,
    levelId: existing.levelId,
    childKind: kind,
    childId: existing.id,
    parentId,
    rows,
  });

  if (kind !== "ots" && params.supplier) {
    throw new DomainError("supplier is only valid on OTS items");
  }

  const [node] = await db
    .update(schema.architectureNodes)
    .set({
      title: params.title,
      description: params.description ?? existing.description,
      parentId,
      supplier: kind === "ots" ? (params.supplier !== undefined ? params.supplier?.trim() || null : existing.supplier) : null,
      updatedAt: new Date(),
    })
    .where(and(eq(schema.architectureNodes.id, params.id), eq(schema.architectureNodes.tenantId, params.tenantId)))
    .returning();
  if (!node) throw new DomainError("failed to update architecture node");

  if (params.requirementIds !== undefined) {
    await replaceArchitectureRequirementLinks(db, {
      tenantId: params.tenantId,
      architectureNodeId: node.id,
      productId: node.productId,
      requirementIds: params.requirementIds,
    });
  }
  if (params.testCaseIds !== undefined) {
    await replaceArchitectureTestCaseLinks(db, {
      tenantId: params.tenantId,
      architectureNodeId: node.id,
      productId: node.productId,
      testCaseIds: params.testCaseIds,
    });
  }

  const level = await getArchitectureLevel(db, params.tenantId, node.levelId);
  const ids = displayOf(level.code, node.sequenceNumber);
  await writeAuditLog(db, {
    tenantId: params.tenantId,
    actorUserId: params.actorUserId,
    action: "architecture.updated",
    entityType: "architecture_node",
    entityId: node.id,
    payload: { kind, title: node.title, displayId: ids.displayId, parentId: node.parentId },
  });

  return { node: { ...node, kind, ...ids } };
}

/** Records a new version for an OTS item: always inserts a fresh, immutable
 * architecture_node_versions row (never updates an existing one - see that table's schema
 * comment for why) and re-points the node's currentVersionId at it. This is the only way
 * `version`/`cpe` ever change - there is no "edit the current version in place" path, which
 * is what makes a stale CPE (mismatched with a newer version's text) structurally
 * impossible: you can't change one without recording both together. */
export async function recordArchitectureNodeVersion(
  db: TenantTx,
  params: {
    tenantId: string;
    architectureNodeId: string;
    version: string;
    cpe?: string | null;
    // Optional identity fields - like `cpe`, only settable at record time.
    releaseDate?: Date | null;
    patchLevel?: string | null;
    upgradeDesignation?: string | null;
    releaseNotesUrl?: string | null;
    createdBy: string;
  },
) {
  const existing = await getRow(db, params.tenantId, params.architectureNodeId);
  const kind = asKind(existing.kind);
  if (kind !== "ots") {
    throw new DomainError("only OTS items can have a version recorded");
  }
  const version = params.version.trim();
  if (!version) {
    throw new DomainError("a version is required");
  }

  const [versionRow] = await db
    .insert(schema.architectureNodeVersions)
    .values({
      tenantId: params.tenantId,
      architectureNodeId: existing.id,
      version,
      cpe: params.cpe?.trim() || null,
      releaseDate: params.releaseDate ?? null,
      patchLevel: params.patchLevel?.trim() || null,
      upgradeDesignation: params.upgradeDesignation?.trim() || null,
      releaseNotesUrl: params.releaseNotesUrl?.trim() || null,
      createdBy: params.createdBy,
    })
    .returning();
  if (!versionRow) throw new DomainError("failed to record version");

  await db
    .update(schema.architectureNodes)
    .set({ currentVersionId: versionRow.id, updatedAt: new Date() })
    .where(and(eq(schema.architectureNodes.id, existing.id), eq(schema.architectureNodes.tenantId, params.tenantId)));

  const level = await getArchitectureLevel(db, params.tenantId, existing.levelId);
  const ids = displayOf(level.code, existing.sequenceNumber);
  await writeAuditLog(db, {
    tenantId: params.tenantId,
    actorUserId: params.createdBy,
    action: "architecture.version_recorded",
    entityType: "architecture_node",
    entityId: existing.id,
    payload: { displayId: ids.displayId, title: existing.title, version },
  });

  return { version: versionRow as ArchitectureNodeVersionView };
}

export async function deleteArchitectureNode(db: TenantTx, tenantId: string, id: string, actorUserId: string) {
  const existing = await getRow(db, tenantId, id);
  const [childCountRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.architectureNodes)
    .where(and(eq(schema.architectureNodes.parentId, id), eq(schema.architectureNodes.tenantId, tenantId)));
  const childCount = childCountRow?.count ?? 0;
  if (childCount > 0) {
    throw new DomainError(
      `cannot delete an architecture node that still has children (${childCount} ${childCount === 1 ? "child" : "children"})`,
    );
  }

  const level = await getArchitectureLevel(db, tenantId, existing.levelId);
  const displayId = formatItemId(level.code, existing.sequenceNumber);

  await db
    .delete(schema.architectureNodes)
    .where(and(eq(schema.architectureNodes.id, id), eq(schema.architectureNodes.tenantId, tenantId)));

  const reclaimed = await decrementSequenceCounterIfTip(
    db,
    tenantId,
    existing.productId,
    existing.levelId,
    existing.sequenceNumber,
  );

  await writeAuditLog(db, {
    tenantId,
    actorUserId,
    action: "architecture.deleted",
    entityType: "architecture_node",
    entityId: id,
    payload: { displayId, title: existing.title, numberReclaimed: reclaimed },
  });
}

export type ArchitectureLinkRef = {
  id: string;
  title: string;
  sequenceNumber: number;
  levelCode: string;
  displayId: string;
};

export type ArchitectureNodeLinkRef = ArchitectureLinkRef & {
  kind: ArchitectureKind;
};

async function assertSameProductRequirements(
  db: TenantTx,
  tenantId: string,
  productId: string,
  requirementIds: string[],
) {
  if (requirementIds.length === 0) return;
  const unique = [...new Set(requirementIds)];
  const rows = await db
    .select({ id: schema.requirements.id, productId: schema.requirements.productId })
    .from(schema.requirements)
    .where(and(eq(schema.requirements.tenantId, tenantId), inArray(schema.requirements.id, unique)));
  if (rows.length !== unique.length) {
    throw new DomainError("one or more requirements were not found");
  }
  if (rows.some((r) => r.productId !== productId)) {
    throw new DomainError("linked requirements must belong to the same product");
  }
}

async function assertSameProductTestCases(db: TenantTx, tenantId: string, productId: string, testCaseIds: string[]) {
  if (testCaseIds.length === 0) return;
  const unique = [...new Set(testCaseIds)];
  const rows = await db
    .select({ id: schema.testCases.id, productId: schema.testCases.productId })
    .from(schema.testCases)
    .where(and(eq(schema.testCases.tenantId, tenantId), inArray(schema.testCases.id, unique)));
  if (rows.length !== unique.length) {
    throw new DomainError("one or more test cases were not found");
  }
  if (rows.some((r) => r.productId !== productId)) {
    throw new DomainError("linked test cases must belong to the same product");
  }
}

async function assertSameProductArchitectureNodes(
  db: TenantTx,
  tenantId: string,
  productId: string,
  architectureNodeIds: string[],
) {
  if (architectureNodeIds.length === 0) return;
  const unique = [...new Set(architectureNodeIds)];
  const rows = await db
    .select({ id: schema.architectureNodes.id, productId: schema.architectureNodes.productId })
    .from(schema.architectureNodes)
    .where(and(eq(schema.architectureNodes.tenantId, tenantId), inArray(schema.architectureNodes.id, unique)));
  if (rows.length !== unique.length) {
    throw new DomainError("one or more architecture nodes were not found");
  }
  if (rows.some((r) => r.productId !== productId)) {
    throw new DomainError("linked architecture nodes must belong to the same product");
  }
}

/** Replace-all write for architecture → requirement links (same pattern as test-case
 * requirementIds on updateTestCase). */
export async function replaceArchitectureRequirementLinks(
  db: TenantTx,
  params: { tenantId: string; architectureNodeId: string; productId: string; requirementIds: string[] },
) {
  await assertSameProductRequirements(db, params.tenantId, params.productId, params.requirementIds);
  await db
    .delete(schema.architectureNodeRequirementLinks)
    .where(
      and(
        eq(schema.architectureNodeRequirementLinks.architectureNodeId, params.architectureNodeId),
        eq(schema.architectureNodeRequirementLinks.tenantId, params.tenantId),
      ),
    );
  const unique = [...new Set(params.requirementIds)];
  if (unique.length === 0) return;
  await db.insert(schema.architectureNodeRequirementLinks).values(
    unique.map((requirementId) => ({
      tenantId: params.tenantId,
      architectureNodeId: params.architectureNodeId,
      requirementId,
    })),
  );
}

export async function replaceArchitectureTestCaseLinks(
  db: TenantTx,
  params: { tenantId: string; architectureNodeId: string; productId: string; testCaseIds: string[] },
) {
  await assertSameProductTestCases(db, params.tenantId, params.productId, params.testCaseIds);
  await db
    .delete(schema.architectureNodeTestCaseLinks)
    .where(
      and(
        eq(schema.architectureNodeTestCaseLinks.architectureNodeId, params.architectureNodeId),
        eq(schema.architectureNodeTestCaseLinks.tenantId, params.tenantId),
      ),
    );
  const unique = [...new Set(params.testCaseIds)];
  if (unique.length === 0) return;
  await db.insert(schema.architectureNodeTestCaseLinks).values(
    unique.map((testCaseId) => ({
      tenantId: params.tenantId,
      architectureNodeId: params.architectureNodeId,
      testCaseId,
    })),
  );
}

/** Inverse of replaceArchitectureRequirementLinks: set which architecture nodes a
 * requirement links to (replace-all from the requirement side). */
export async function replaceRequirementArchitectureLinks(
  db: TenantTx,
  params: { tenantId: string; requirementId: string; productId: string; architectureNodeIds: string[] },
) {
  await assertSameProductArchitectureNodes(db, params.tenantId, params.productId, params.architectureNodeIds);
  await db
    .delete(schema.architectureNodeRequirementLinks)
    .where(
      and(
        eq(schema.architectureNodeRequirementLinks.requirementId, params.requirementId),
        eq(schema.architectureNodeRequirementLinks.tenantId, params.tenantId),
      ),
    );
  const unique = [...new Set(params.architectureNodeIds)];
  if (unique.length === 0) return;
  await db.insert(schema.architectureNodeRequirementLinks).values(
    unique.map((architectureNodeId) => ({
      tenantId: params.tenantId,
      architectureNodeId,
      requirementId: params.requirementId,
    })),
  );
}

export async function replaceTestCaseArchitectureLinks(
  db: TenantTx,
  params: { tenantId: string; testCaseId: string; productId: string; architectureNodeIds: string[] },
) {
  await assertSameProductArchitectureNodes(db, params.tenantId, params.productId, params.architectureNodeIds);
  await db
    .delete(schema.architectureNodeTestCaseLinks)
    .where(
      and(
        eq(schema.architectureNodeTestCaseLinks.testCaseId, params.testCaseId),
        eq(schema.architectureNodeTestCaseLinks.tenantId, params.tenantId),
      ),
    );
  const unique = [...new Set(params.architectureNodeIds)];
  if (unique.length === 0) return;
  await db.insert(schema.architectureNodeTestCaseLinks).values(
    unique.map((architectureNodeId) => ({
      tenantId: params.tenantId,
      architectureNodeId,
      testCaseId: params.testCaseId,
    })),
  );
}

export async function listRequirementLinksForNode(
  db: TenantTx,
  tenantId: string,
  architectureNodeId: string,
): Promise<ArchitectureLinkRef[]> {
  const rows = await db
    .select({
      id: schema.requirements.id,
      title: schema.requirementVersions.title,
      sequenceNumber: schema.requirements.sequenceNumber,
      levelCode: schema.levels.code,
    })
    .from(schema.architectureNodeRequirementLinks)
    .innerJoin(schema.requirements, eq(schema.architectureNodeRequirementLinks.requirementId, schema.requirements.id))
    .innerJoin(schema.requirementVersions, eq(schema.requirements.currentVersionId, schema.requirementVersions.id))
    .innerJoin(schema.levels, eq(schema.requirements.levelId, schema.levels.id))
    .where(
      and(
        eq(schema.architectureNodeRequirementLinks.architectureNodeId, architectureNodeId),
        eq(schema.architectureNodeRequirementLinks.tenantId, tenantId),
      ),
    )
    .orderBy(asc(schema.levels.sortOrder), asc(schema.requirements.sequenceNumber));
  return rows.map((r) => ({ ...r, displayId: formatItemId(r.levelCode, r.sequenceNumber) }));
}

export async function listTestCaseLinksForNode(
  db: TenantTx,
  tenantId: string,
  architectureNodeId: string,
): Promise<ArchitectureLinkRef[]> {
  const rows = await db
    .select({
      id: schema.testCases.id,
      title: schema.testCases.title,
      sequenceNumber: schema.testCases.sequenceNumber,
      levelCode: schema.levels.code,
    })
    .from(schema.architectureNodeTestCaseLinks)
    .innerJoin(schema.testCases, eq(schema.architectureNodeTestCaseLinks.testCaseId, schema.testCases.id))
    .innerJoin(schema.levels, eq(schema.testCases.levelId, schema.levels.id))
    .where(
      and(
        eq(schema.architectureNodeTestCaseLinks.architectureNodeId, architectureNodeId),
        eq(schema.architectureNodeTestCaseLinks.tenantId, tenantId),
      ),
    )
    .orderBy(asc(schema.levels.sortOrder), asc(schema.testCases.sequenceNumber));
  return rows.map((r) => ({ ...r, displayId: formatItemId(r.levelCode, r.sequenceNumber) }));
}

export async function listArchitectureLinksForRequirement(
  db: TenantTx,
  tenantId: string,
  requirementId: string,
): Promise<ArchitectureNodeLinkRef[]> {
  const rows = await db
    .select({
      id: schema.architectureNodes.id,
      title: schema.architectureNodes.title,
      kind: schema.architectureNodes.kind,
      sequenceNumber: schema.architectureNodes.sequenceNumber,
      levelCode: schema.levels.code,
    })
    .from(schema.architectureNodeRequirementLinks)
    .innerJoin(
      schema.architectureNodes,
      eq(schema.architectureNodeRequirementLinks.architectureNodeId, schema.architectureNodes.id),
    )
    .innerJoin(schema.levels, eq(schema.architectureNodes.levelId, schema.levels.id))
    .where(
      and(
        eq(schema.architectureNodeRequirementLinks.requirementId, requirementId),
        eq(schema.architectureNodeRequirementLinks.tenantId, tenantId),
      ),
    )
    .orderBy(asc(schema.levels.sortOrder), asc(schema.architectureNodes.sequenceNumber));
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    kind: asKind(r.kind),
    sequenceNumber: r.sequenceNumber,
    levelCode: r.levelCode,
    displayId: formatItemId(r.levelCode, r.sequenceNumber),
  }));
}

export async function listArchitectureLinksForTestCase(
  db: TenantTx,
  tenantId: string,
  testCaseId: string,
): Promise<ArchitectureNodeLinkRef[]> {
  const rows = await db
    .select({
      id: schema.architectureNodes.id,
      title: schema.architectureNodes.title,
      kind: schema.architectureNodes.kind,
      sequenceNumber: schema.architectureNodes.sequenceNumber,
      levelCode: schema.levels.code,
    })
    .from(schema.architectureNodeTestCaseLinks)
    .innerJoin(
      schema.architectureNodes,
      eq(schema.architectureNodeTestCaseLinks.architectureNodeId, schema.architectureNodes.id),
    )
    .innerJoin(schema.levels, eq(schema.architectureNodes.levelId, schema.levels.id))
    .where(
      and(
        eq(schema.architectureNodeTestCaseLinks.testCaseId, testCaseId),
        eq(schema.architectureNodeTestCaseLinks.tenantId, tenantId),
      ),
    )
    .orderBy(asc(schema.levels.sortOrder), asc(schema.architectureNodes.sequenceNumber));
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    kind: asKind(r.kind),
    sequenceNumber: r.sequenceNumber,
    levelCode: r.levelCode,
    displayId: formatItemId(r.levelCode, r.sequenceNumber),
  }));
}

/** Flat list for the Architecture tab's Trace view: every node on a level with its
 * linked requirements and test cases. */
export async function listArchitectureTrace(
  db: TenantTx,
  tenantId: string,
  productId: string,
  levelId: string,
) {
  const level = await getArchitectureLevel(db, tenantId, levelId);
  const nodes = await listRows(db, tenantId, productId, levelId);
  if (nodes.length === 0) {
    return { level, rows: [] };
  }

  const nodeIds = nodes.map((n) => n.id);
  const [reqLinks, tcLinks] = await Promise.all([
    db
      .select({
        architectureNodeId: schema.architectureNodeRequirementLinks.architectureNodeId,
        id: schema.requirements.id,
        title: schema.requirementVersions.title,
        sequenceNumber: schema.requirements.sequenceNumber,
        levelCode: schema.levels.code,
      })
      .from(schema.architectureNodeRequirementLinks)
      .innerJoin(schema.requirements, eq(schema.architectureNodeRequirementLinks.requirementId, schema.requirements.id))
      .innerJoin(schema.requirementVersions, eq(schema.requirements.currentVersionId, schema.requirementVersions.id))
      .innerJoin(schema.levels, eq(schema.requirements.levelId, schema.levels.id))
      .where(
        and(
          eq(schema.architectureNodeRequirementLinks.tenantId, tenantId),
          inArray(schema.architectureNodeRequirementLinks.architectureNodeId, nodeIds),
        ),
      ),
    db
      .select({
        architectureNodeId: schema.architectureNodeTestCaseLinks.architectureNodeId,
        id: schema.testCases.id,
        title: schema.testCases.title,
        sequenceNumber: schema.testCases.sequenceNumber,
        levelCode: schema.levels.code,
      })
      .from(schema.architectureNodeTestCaseLinks)
      .innerJoin(schema.testCases, eq(schema.architectureNodeTestCaseLinks.testCaseId, schema.testCases.id))
      .innerJoin(schema.levels, eq(schema.testCases.levelId, schema.levels.id))
      .where(
        and(
          eq(schema.architectureNodeTestCaseLinks.tenantId, tenantId),
          inArray(schema.architectureNodeTestCaseLinks.architectureNodeId, nodeIds),
        ),
      ),
  ]);

  const reqsByNode = new Map<string, ArchitectureLinkRef[]>();
  for (const link of reqLinks) {
    const list = reqsByNode.get(link.architectureNodeId) ?? [];
    list.push({
      id: link.id,
      title: link.title,
      sequenceNumber: link.sequenceNumber,
      levelCode: link.levelCode,
      displayId: formatItemId(link.levelCode, link.sequenceNumber),
    });
    reqsByNode.set(link.architectureNodeId, list);
  }
  const tcsByNode = new Map<string, ArchitectureLinkRef[]>();
  for (const link of tcLinks) {
    const list = tcsByNode.get(link.architectureNodeId) ?? [];
    list.push({
      id: link.id,
      title: link.title,
      sequenceNumber: link.sequenceNumber,
      levelCode: link.levelCode,
      displayId: formatItemId(link.levelCode, link.sequenceNumber),
    });
    tcsByNode.set(link.architectureNodeId, list);
  }

  function rowWithLinks(node: ArchitectureNodeRow) {
    const ids = displayOf(level.code, node.sequenceNumber);
    return {
      id: node.id,
      kind: asKind(node.kind),
      title: node.title,
      parentId: node.parentId,
      ...ids,
      requirementLinks: reqsByNode.get(node.id) ?? [],
      testCaseLinks: tcsByNode.get(node.id) ?? [],
    };
  }

  return { level, rows: nodes.map(rowWithLinks) };
}

/** Batch counts for requirement/test-case list columns. */
export async function countArchitectureLinksByRequirement(
  db: TenantTx,
  tenantId: string,
  requirementIds: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (requirementIds.length === 0) return counts;
  const rows = await db
    .select({
      requirementId: schema.architectureNodeRequirementLinks.requirementId,
      architectureNodeId: schema.architectureNodeRequirementLinks.architectureNodeId,
    })
    .from(schema.architectureNodeRequirementLinks)
    .where(
      and(
        eq(schema.architectureNodeRequirementLinks.tenantId, tenantId),
        inArray(schema.architectureNodeRequirementLinks.requirementId, requirementIds),
      ),
    );
  const sets = new Map<string, Set<string>>();
  for (const row of rows) {
    const set = sets.get(row.requirementId) ?? new Set();
    set.add(row.architectureNodeId);
    sets.set(row.requirementId, set);
  }
  for (const [id, set] of sets) counts.set(id, set.size);
  return counts;
}

export async function countArchitectureLinksByTestCase(
  db: TenantTx,
  tenantId: string,
  testCaseIds: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (testCaseIds.length === 0) return counts;
  const rows = await db
    .select({
      testCaseId: schema.architectureNodeTestCaseLinks.testCaseId,
      architectureNodeId: schema.architectureNodeTestCaseLinks.architectureNodeId,
    })
    .from(schema.architectureNodeTestCaseLinks)
    .where(
      and(
        eq(schema.architectureNodeTestCaseLinks.tenantId, tenantId),
        inArray(schema.architectureNodeTestCaseLinks.testCaseId, testCaseIds),
      ),
    );
  const sets = new Map<string, Set<string>>();
  for (const row of rows) {
    const set = sets.get(row.testCaseId) ?? new Set();
    set.add(row.architectureNodeId);
    sets.set(row.testCaseId, set);
  }
  for (const [id, set] of sets) counts.set(id, set.size);
  return counts;
}

/** Short labels for list cells (display ids), batched. */
export async function listArchitectureDisplayIdsByRequirement(
  db: TenantTx,
  tenantId: string,
  requirementIds: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (requirementIds.length === 0) return out;
  const rows = await db
    .select({
      requirementId: schema.architectureNodeRequirementLinks.requirementId,
      sequenceNumber: schema.architectureNodes.sequenceNumber,
      levelCode: schema.levels.code,
    })
    .from(schema.architectureNodeRequirementLinks)
    .innerJoin(
      schema.architectureNodes,
      eq(schema.architectureNodeRequirementLinks.architectureNodeId, schema.architectureNodes.id),
    )
    .innerJoin(schema.levels, eq(schema.architectureNodes.levelId, schema.levels.id))
    .where(
      and(
        eq(schema.architectureNodeRequirementLinks.tenantId, tenantId),
        inArray(schema.architectureNodeRequirementLinks.requirementId, requirementIds),
      ),
    )
    .orderBy(asc(schema.levels.sortOrder), asc(schema.architectureNodes.sequenceNumber));
  for (const row of rows) {
    const list = out.get(row.requirementId) ?? [];
    list.push(formatItemId(row.levelCode, row.sequenceNumber));
    out.set(row.requirementId, list);
  }
  return out;
}

export async function listArchitectureDisplayIdsByTestCase(
  db: TenantTx,
  tenantId: string,
  testCaseIds: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (testCaseIds.length === 0) return out;
  const rows = await db
    .select({
      testCaseId: schema.architectureNodeTestCaseLinks.testCaseId,
      sequenceNumber: schema.architectureNodes.sequenceNumber,
      levelCode: schema.levels.code,
    })
    .from(schema.architectureNodeTestCaseLinks)
    .innerJoin(
      schema.architectureNodes,
      eq(schema.architectureNodeTestCaseLinks.architectureNodeId, schema.architectureNodes.id),
    )
    .innerJoin(schema.levels, eq(schema.architectureNodes.levelId, schema.levels.id))
    .where(
      and(
        eq(schema.architectureNodeTestCaseLinks.tenantId, tenantId),
        inArray(schema.architectureNodeTestCaseLinks.testCaseId, testCaseIds),
      ),
    )
    .orderBy(asc(schema.levels.sortOrder), asc(schema.architectureNodes.sequenceNumber));
  for (const row of rows) {
    const list = out.get(row.testCaseId) ?? [];
    list.push(formatItemId(row.levelCode, row.sequenceNumber));
    out.set(row.testCaseId, list);
  }
  return out;
}

