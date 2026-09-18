import { buildScanQuery, DomainError, getArchitectureNode, getArchitectureNodeVersion, recordScanResult } from "@galm/core";
import type { TenantTx } from "@galm/db";
import type { NvdClient } from "./client";

/** Runs one scan of one OTS architecture node: resolves the best available match
 * (exact CPE, else a supplier+title+version keyword), calls NVD, and persists the
 * result (a vulnerability_scans row always, upserted vulnerability_findings on
 * success) via @galm/core's recordScanResult - this function is the only place that
 * both talks to the network (via `client`) and writes scan/finding rows, so
 * packages/core itself never depends on this integration package.
 *
 * `versionId` targets a specific version other than the current one - NVD doesn't care
 * which version is "current" for you, so re-checking an old release is a perfectly valid
 * scan (e.g. a CVE published after you upgraded may still affect a version you shipped
 * last year). Omit it to scan the node's current version, same as before. */
export async function scanArchitectureNode(
  db: TenantTx,
  client: Pick<NvdClient, "searchByCpe" | "searchByKeyword">,
  params: { tenantId: string; nodeId: string; triggeredBy: string; versionId?: string },
) {
  const { node } = await getArchitectureNode(db, params.tenantId, params.nodeId);
  if (node.kind !== "ots") {
    throw new DomainError("only OTS items can be scanned for vulnerabilities");
  }

  const targetVersion = params.versionId
    ? await getArchitectureNodeVersion(db, params.tenantId, params.nodeId, params.versionId)
    : node.currentVersion;
  if (!targetVersion) {
    throw new DomainError("record a version before scanning this item");
  }

  const scanQuery = buildScanQuery({
    cpe: targetVersion.cpe,
    supplier: node.supplier,
    title: node.title,
    version: targetVersion.version,
  });
  if (!scanQuery) {
    throw new DomainError("record a version before scanning this item");
  }

  try {
    const findings =
      scanQuery.matchType === "cpe" ? await client.searchByCpe(scanQuery.query) : await client.searchByKeyword(scanQuery.query);
    return await recordScanResult(db, {
      tenantId: params.tenantId,
      architectureNodeId: params.nodeId,
      architectureNodeVersionId: targetVersion.id,
      triggeredBy: params.triggeredBy,
      matchType: scanQuery.matchType,
      query: scanQuery.query,
      ok: true,
      findings,
    });
  } catch (err) {
    await recordScanResult(db, {
      tenantId: params.tenantId,
      architectureNodeId: params.nodeId,
      architectureNodeVersionId: targetVersion.id,
      triggeredBy: params.triggeredBy,
      matchType: scanQuery.matchType,
      query: scanQuery.query,
      ok: false,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
