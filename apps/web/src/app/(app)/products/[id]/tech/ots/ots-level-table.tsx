"use client";

import { FilterChip } from "@/components/filter-chip";
import { Frame } from "@/components/frame";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { type FilterDef, useListFilters } from "@/lib/list-filters";
import { trpc } from "@/lib/trpc-client";
import Link from "next/link";
import { Fragment, useMemo, useState } from "react";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One level's OTS items per version, with Scan / Scan all. */
export function OtsLevelTable({
  productId,
  levelId,
  itemHref,
}: {
  productId: string;
  levelId: string | null;
  /** `tab` overrides the current item tab. */
  itemHref: (nodeId: string, tab?: string) => string;
}) {
  const utils = trpc.useUtils();
  const connection = trpc.vulnerabilities.getConnection.useQuery();
  const summary = trpc.vulnerabilities.otsSummary.useQuery({ productId, levelId: levelId! }, { enabled: !!levelId });
  const softwareVersionOptions = trpc.softwareVersions.listByProduct.useQuery({ productId });
  // Declarative filters - see list-filters.ts. Filters a *version* row, not a node row -
  // each node can have several, one per OTS component version.
  const filterDefs = useMemo<FilterDef<NonNullable<typeof summary.data>[number]["versions"][number]>[]>(
    () => [
      {
        id: "version",
        label: "Version",
        options: (softwareVersionOptions.data ?? []).map((v) => ({ value: v.id, label: v.versionNumber })),
        matches: (row, v) => row.softwareVersions.some((sv) => sv.id === v),
      },
    ],
    [softwareVersionOptions.data],
  );
  const filters = useListFilters(filterDefs);
  const scanNode = trpc.vulnerabilities.scanNode.useMutation({
    onSuccess: () => {
      if (levelId) utils.vulnerabilities.otsSummary.invalidate({ productId, levelId });
    },
  });
  const [scanningId, setScanningId] = useState<string | null>(null);
  const [bulkState, setBulkState] = useState<{
    total: number;
    done: number;
    failedCount: number;
    noVersionCount: number;
    lastError: string | null;
  } | null>(null);
  // Off by default - a plain node/version/findings row is what most teams look at day to
  // day. Full history is there for when you need to see what an old version looked like,
  // and is the seam a future "releases" feature (pin to a named set of versions) will
  // hang its own filter off of instead of this simple current-vs-all toggle.
  const [showAllVersions, setShowAllVersions] = useState(false);

  async function scanOne(nodeId: string, versionId?: string) {
    setScanningId(`${nodeId}:${versionId ?? "current"}`);
    try {
      await scanNode.mutateAsync({ nodeId, versionId });
    } catch {
      // Surfaced via scanNode.error for the single-item case; bulk scan handles its
      // own failure counting separately (see scanAll below).
    } finally {
      setScanningId(null);
    }
  }

  async function scanAll() {
    if (!summary.data || summary.data.length === 0) return;
    // Skip nodes with no current version up front - scanning one always fails ("record a
    // version before scanning this item"), and lumping that into "failed" alongside real
    // scan errors made a completely different problem look like a rate-limit issue.
    const eligible = summary.data.filter((row) => row.versions.some((v) => v.isCurrent));
    const noVersionCount = summary.data.length - eligible.length;
    const nodeIds = eligible.map((row) => row.node.id);
    const throttleMs = connection.data?.suggestedThrottleMs ?? 6500;
    let failedCount = 0;
    let lastError: string | null = null;
    setBulkState({ total: nodeIds.length, done: 0, failedCount: 0, noVersionCount, lastError: null });
    for (const nodeId of nodeIds) {
      let attempt = 0;
      for (;;) {
        try {
          await scanNode.mutateAsync({ nodeId });
          break;
        } catch (err) {
          const message = err instanceof Error ? err.message : "scan failed";
          const rateLimited = message.toLowerCase().includes("rate-limited");
          if (rateLimited && attempt < 2) {
            attempt++;
            await sleep(throttleMs * 2 ** attempt);
            continue;
          }
          failedCount++;
          lastError = message;
          break;
        }
      }
      setBulkState((prev) => (prev ? { ...prev, done: prev.done + 1, failedCount, lastError } : prev));
      await sleep(throttleMs);
    }
  }

  if (!levelId) return null;

  return (
    <div>
      {!connection.data?.hasApiKey && (
        <p className="mb-3 text-[12.5px] text-muted-foreground">
          Add an NVD API key in{" "}
          <Link href="/settings/nvd" className="underline underline-offset-2 hover:text-foreground">
            Settings
          </Link>{" "}
          to speed up scans (5 → 50 requests per 30 seconds).
        </p>
      )}
      <div className="mb-3 flex items-center justify-between">
        <p className="font-mono text-[10.5px] tracking-[0.1em] text-muted-foreground uppercase">Off-the-shelf items</p>
        <div className="flex items-center gap-4">
          <Label className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
            <Switch size="sm" checked={showAllVersions} onCheckedChange={setShowAllVersions} />
            Show all versions
          </Label>
          {filterDefs.map((def) => (
            <FilterChip key={def.id} def={def} value={filters.active[def.id]} onChange={(v) => filters.setFilter(def.id, v)} />
          ))}
          <Button
            type="button"
            size="sm"
            disabled={!summary.data?.some((row) => row.versions.some((v) => v.isCurrent)) || !!bulkState}
            onClick={scanAll}
          >
            {bulkState ? "Scanning all…" : "Scan all"}
          </Button>
        </div>
      </div>
      {bulkState && (
        <p className="mb-2 text-[12.5px] text-muted-foreground">
          Scanned {bulkState.done}/{bulkState.total}
          {bulkState.noVersionCount > 0 &&
            ` — ${bulkState.noVersionCount} skipped (no version recorded)`}
          {bulkState.failedCount > 0 &&
            ` — ${bulkState.failedCount} failed${bulkState.lastError ? `: ${bulkState.lastError}` : ""}`}
          {bulkState.done === bulkState.total && (
            <button type="button" className="ml-2 underline" onClick={() => setBulkState(null)}>
              Dismiss
            </button>
          )}
        </p>
      )}
      {summary.isLoading && <p className="text-[13.5px] text-muted-foreground">Loading...</p>}
      {summary.error && <p className="text-sm text-destructive">{summary.error.message}</p>}
      {summary.data && (
        <Frame className="bg-card">
          {summary.data.length === 0 ? (
            <p className="px-4 py-6 text-[13.5px] text-muted-foreground">No OTS items on this level yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead>Supplier</TableHead>
                  <TableHead>Version</TableHead>
                  <TableHead>CPE</TableHead>
                  <TableHead>Versions</TableHead>
                  <TableHead>Findings</TableHead>
                  <TableHead>Last scanned</TableHead>
                  <TableHead className="w-[80px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {summary.data.map((row) => {
                  const baseVersions = showAllVersions ? row.versions : row.versions.filter((v) => v.isCurrent);
                  if (row.versions.length === 0) {
                    // No version recorded yet - one placeholder row for the node itself,
                    // shown regardless of the version filter (there's nothing to filter).
                    return (
                      <TableRow key={row.node.id}>
                        <TableCell>
                          <Link href={itemHref(row.node.id)} className="text-foreground hover:underline">
                            {row.node.title}
                          </Link>
                        </TableCell>
                        <TableCell className="text-[13px] text-muted-foreground">{row.node.supplier ?? "—"}</TableCell>
                        <TableCell colSpan={6} className="text-[13px] text-muted-foreground">
                          No version recorded yet -{" "}
                          <Link href={itemHref(row.node.id, "versions")} className="underline underline-offset-2">
                            add one
                          </Link>
                          .
                        </TableCell>
                      </TableRow>
                    );
                  }
                  const visibleVersions = filters.applyFilters(baseVersions);
                  // Every version this node has exists, just none tag the selected
                  // release - omit the node entirely rather than showing a misleading
                  // "no version recorded" placeholder for an item that in fact has one.
                  if (visibleVersions.length === 0) return null;
                  return (
                    <Fragment key={row.node.id}>
                      {visibleVersions.map((version, i) => (
                        <TableRow key={version.id}>
                          {i === 0 && (
                            <>
                              <TableCell rowSpan={visibleVersions.length}>
                                <Link href={itemHref(row.node.id)} className="text-foreground hover:underline">
                                  {row.node.title}
                                </Link>
                              </TableCell>
                              <TableCell rowSpan={visibleVersions.length} className="text-[13px] text-muted-foreground">
                                {row.node.supplier ?? "—"}
                              </TableCell>
                            </>
                          )}
                          <TableCell className="text-[13px] text-muted-foreground">
                            {version.version}
                            {showAllVersions && visibleVersions.length > 1 && version.isCurrent && (
                              <Badge variant="outline" className="ml-1.5">
                                current
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell
                            className="max-w-[220px] truncate font-mono text-[11.5px] text-muted-foreground"
                            title={version.cpe ?? undefined}
                          >
                            {version.cpe ?? "—"}
                          </TableCell>
                          <TableCell className="max-w-[140px] truncate text-[12.5px] text-muted-foreground">
                            {version.softwareVersions.length > 0
                              ? version.softwareVersions.map((v) => v.versionNumber).join(", ")
                              : "—"}
                          </TableCell>
                          <TableCell>
                            {version.counts.total === 0 ? (
                              <span className="text-[12.5px] text-muted-foreground">—</span>
                            ) : (
                              <div className="flex gap-1">
                                {version.counts.new > 0 && <Badge variant="destructive">{version.counts.new} new</Badge>}
                                {version.counts.notApplicable > 0 && (
                                  <Badge variant="outline">{version.counts.notApplicable} not applicable</Badge>
                                )}
                                {version.counts.falsePositive > 0 && (
                                  <Badge variant="secondary">{version.counts.falsePositive} false positive</Badge>
                                )}
                              </div>
                            )}
                          </TableCell>
                          <TableCell className="text-[12.5px] text-muted-foreground">
                            {version.latestScan ? (
                              version.latestScan.status === "failed" ? (
                                <span className="text-destructive" title={version.latestScan.errorMessage ?? undefined}>
                                  Failed
                                </span>
                              ) : (
                                new Date(version.latestScan.createdAt).toLocaleString()
                              )
                            ) : (
                              "Never"
                            )}
                          </TableCell>
                          <TableCell>
                            {/* NVD doesn't care which version is "current" for you - a
                                past version can be re-checked at any time (a CVE
                                published after you upgraded may still affect a version
                                you shipped last year), so every version row gets its own
                                Scan button, not just the current one. */}
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={scanningId === `${row.node.id}:${version.isCurrent ? "current" : version.id}` || !!bulkState}
                              onClick={() => scanOne(row.node.id, version.isCurrent ? undefined : version.id)}
                            >
                              {scanningId === `${row.node.id}:${version.isCurrent ? "current" : version.id}`
                                ? "Scanning…"
                                : "Scan"}
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </Frame>
      )}
    </div>
  );
}
