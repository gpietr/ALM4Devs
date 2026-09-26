"use client";

import { Frame } from "@/components/frame";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { architectureNodeHref } from "@/lib/product-nav";
import { trpc } from "@/lib/trpc-client";
import Link from "next/link";
import { KIND_SHORT_LABEL } from "./create-node-dialog";

/** One level's nodes with their requirement and test case links. */
export function TraceTable({ productId, levelId }: { productId: string; levelId: string }) {
  const trace = trpc.architecture.listTrace.useQuery({ productId, levelId });

  if (trace.isLoading) return <p className="text-[13.5px] text-muted-foreground">Loading…</p>;
  if (trace.error) return <p className="text-sm text-destructive">{trace.error.message}</p>;
  if (!trace.data) return null;

  return (
    <Frame className="bg-card">
      {trace.data.rows.length === 0 ? (
        <p className="px-4 py-6 text-[13.5px] text-muted-foreground">No architecture nodes on this level yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[110px]">ID</TableHead>
              <TableHead className="w-[72px]">Kind</TableHead>
              <TableHead>Node</TableHead>
              <TableHead>Requirements</TableHead>
              <TableHead>Test cases</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {trace.data.rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell>
                  <Link href={architectureNodeHref(productId, row.id)} className="font-mono text-[13px] font-medium text-foreground">
                    {row.displayId}
                  </Link>
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{KIND_SHORT_LABEL[row.kind]}</Badge>
                </TableCell>
                <TableCell className="max-w-xs whitespace-normal">
                  <Link href={architectureNodeHref(productId, row.id)} className="text-foreground hover:underline">
                    {row.title}
                  </Link>
                </TableCell>
                <TableCell className="max-w-sm whitespace-normal text-[13px]">
                  {row.requirementLinks.length > 0 ? (
                    row.requirementLinks.map((r, i) => (
                      <span key={r.id}>
                        {i > 0 && ", "}
                        <Link href={`/requirements/${r.id}`} className="font-mono text-[12.5px] hover:text-primary">
                          {r.displayId}
                        </Link>
                      </span>
                    ))
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="max-w-sm whitespace-normal text-[13px]">
                  {row.testCaseLinks.length > 0 ? (
                    row.testCaseLinks.map((tc, i) => (
                      <span key={tc.id}>
                        {i > 0 && ", "}
                        <Link href={`/test-cases/${tc.id}`} className="font-mono text-[12.5px] hover:text-primary">
                          {tc.displayId}
                        </Link>
                      </span>
                    ))
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Frame>
  );
}
