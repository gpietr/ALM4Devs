"use client";

import { Frame } from "@/components/frame";
import { GenerateDocumentButton } from "@/components/generate-document-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { trpc } from "@/lib/trpc-client";
import { Download } from "lucide-react";
import Link from "next/link";

// Standalone copy - @galm/core's barrel pulls in the database layer.
export const CATEGORY_LABEL: Record<string, string> = {
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

function isoDate(value: string | Date | null): string {
  return value ? new Date(value).toISOString().slice(0, 10) : "";
}

/** Every OTS item across all architecture levels, with CSV and `ots_list` PDF exports. */
export function OtsRegisterView({
  productId,
  productName,
  itemHref,
}: {
  productId: string;
  productName: string;
  itemHref: (nodeId: string) => string;
}) {
  const register = trpc.ots.register.useQuery({ productId });
  const rows = register.data ?? [];

  function exportCsv() {
    const header = [
      "ID",
      "OTS software",
      "Manufacturer",
      "Category",
      "Current version",
      "Patch",
      "Allowed versions",
      "End of support",
      "Intended function",
      "Known issues",
      "Issues not assessed",
      "Issues not acceptable",
      "Issue list reviewed",
      "Open CVEs",
      "Linked test cases",
      "Documented",
    ];
    const csvRows = rows.map((r) => [
      r.node.displayId,
      r.node.title,
      r.node.supplier ?? "",
      r.category ? CATEGORY_LABEL[r.category] ?? r.category : "",
      r.currentVersion?.version ?? "",
      r.currentVersion?.patchLevel ?? "",
      r.allowedVersions.join(", "),
      isoDate(r.endOfSupportDate),
      r.intendedFunction ?? "",
      r.anomalyCounts.total,
      r.anomalyCounts.unassessed,
      r.anomalyCounts.notAcceptable,
      isoDate(r.anomaliesReviewedAt),
      r.openCveCount,
      r.linkedTestCaseCount,
      `${r.completeness.filled}/${r.completeness.total}`,
    ]);
    const escape = (cell: string) => `"${cell.replaceAll('"', '""')}"`;
    const csv = [header, ...csvRows].map((row) => row.map((cell) => escape(String(cell))).join(",")).join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${productName} - OTS register.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <div className="mb-3 flex items-start justify-between gap-3">
        <p className="max-w-2xl text-[12.5px] text-muted-foreground">
          Every OTS item in this product, across all architecture levels. Open an item&rsquo;s Documentation tab to fill in
          its details.
        </p>
        <div className="flex shrink-0 gap-2">
          <GenerateDocumentButton scope="ots_list" buildRequestBody={() => ({ productId })} />
          <Button type="button" variant="outline" size="sm" onClick={exportCsv} disabled={rows.length === 0} className="gap-1.5">
            <Download />
            Export CSV
          </Button>
        </div>
      </div>
      {register.isLoading && <p className="text-[13.5px] text-muted-foreground">Loading...</p>}
      {register.error && <p className="text-sm text-destructive">{register.error.message}</p>}
      {register.data && (
        <Frame className="bg-card">
          {rows.length === 0 ? (
            <p className="px-4 py-6 text-[13.5px] text-muted-foreground">No OTS items in this product yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead>Manufacturer</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Version</TableHead>
                  <TableHead>Allowed</TableHead>
                  <TableHead>End of support</TableHead>
                  <TableHead>Known issues</TableHead>
                  <TableHead>CVEs</TableHead>
                  <TableHead>Tests</TableHead>
                  <TableHead>Documented</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const complete = r.completeness.filled === r.completeness.total;
                  return (
                    <TableRow key={r.node.id}>
                      <TableCell>
                        <Link href={itemHref(r.node.id)} className="hover:underline">
                          <span className="mr-1.5 font-mono text-[11.5px] text-muted-foreground">{r.node.displayId}</span>
                          {r.node.title}
                        </Link>
                      </TableCell>
                      <TableCell className="text-[13px] text-muted-foreground">{r.node.supplier ?? "—"}</TableCell>
                      <TableCell className="text-[13px] text-muted-foreground">
                        {r.category ? CATEGORY_LABEL[r.category] ?? r.category : "—"}
                      </TableCell>
                      <TableCell className="text-[13px]">
                        {r.currentVersion ? (
                          <>
                            {r.currentVersion.version}
                            {r.currentVersion.patchLevel && (
                              <span className="text-muted-foreground"> · {r.currentVersion.patchLevel}</span>
                            )}
                          </>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-[12.5px] text-muted-foreground">
                        {r.allowedVersions.length > 0 ? r.allowedVersions.join(", ") : "—"}
                      </TableCell>
                      <TableCell className="text-[12.5px] text-muted-foreground">
                        {r.endOfSupportDate ? isoDate(r.endOfSupportDate) : "—"}
                      </TableCell>
                      <TableCell>
                        {r.anomalyCounts.total === 0 ? (
                          <span className="text-[12.5px] text-muted-foreground">—</span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            <span className="text-[12.5px]">{r.anomalyCounts.total}</span>
                            {r.anomalyCounts.unassessed > 0 && <Badge variant="destructive">{r.anomalyCounts.unassessed} not assessed</Badge>}
                            {r.anomalyCounts.notAcceptable > 0 && (
                              <Badge variant="destructive">{r.anomalyCounts.notAcceptable} not acceptable</Badge>
                            )}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-[12.5px]">
                        {r.openCveCount > 0 ? <Badge variant="destructive">{r.openCveCount} open</Badge> : <span className="text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell className="text-[12.5px] text-muted-foreground">{r.linkedTestCaseCount || "—"}</TableCell>
                      <TableCell>
                        <span
                          className={`font-mono text-[12px] ${complete ? "text-foreground" : "text-muted-foreground"}`}
                          title={r.completeness.gaps.filter((g) => !g.enhancedOnly).map((g) => g.message).join("\n")}
                        >
                          {r.completeness.filled}/{r.completeness.total}
                        </span>
                      </TableCell>
                    </TableRow>
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
