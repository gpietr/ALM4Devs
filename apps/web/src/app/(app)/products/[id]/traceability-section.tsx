"use client";

import {
  asCustomFieldDefinitions,
  type CustomFieldDefinitionView,
  CustomFieldColumnPicker,
  formatCustomFieldValue,
} from "@/components/custom-fields";
import { Frame } from "@/components/frame";
import { ResultBadge } from "@/components/result-badge";
import { SortableTableHead } from "@/components/sortable-table-head";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatItemId } from "@/lib/format-item-id";
import { trpc } from "@/lib/trpc-client";
import { useUrlState } from "@/lib/use-url-state";
import { Download } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";

const ANY = "any";

interface MatrixRow {
  requirementSequenceNumber: number;
  requirementTitle: string;
  testCaseId: string | null;
  testCaseTitle: string | null;
  testCaseSequenceNumber: number | null;
  lastExecutionStatus: string | null;
  lastExecutionStartedAt: Date | string | null;
}

/** One combined status filter rather than two ("coverage" + "execution status") - a
 * requirement is either uncovered (a real gap), covered but never run, or run with some
 * result, and a QMS reviewer thinks in exactly those terms, not in two orthogonal facets. */
function matchesStatusFilter(row: MatrixRow, filter: string): boolean {
  if (filter === ANY) return true;
  if (filter === "not_covered") return !row.testCaseId;
  if (filter === "never_run") return !!row.testCaseId && !row.lastExecutionStatus;
  return row.lastExecutionStatus === filter;
}

function compareMatrixRows(a: MatrixRow, b: MatrixRow, sortBy: string): number {
  switch (sortBy) {
    case "reqId":
      return a.requirementSequenceNumber - b.requirementSequenceNumber;
    case "requirement":
      return a.requirementTitle.localeCompare(b.requirementTitle);
    case "testCase":
      return (a.testCaseTitle ?? "").localeCompare(b.testCaseTitle ?? "");
    case "lastExecution": {
      const aTime = a.lastExecutionStartedAt ? new Date(a.lastExecutionStartedAt).getTime() : 0;
      const bTime = b.lastExecutionStartedAt ? new Date(b.lastExecutionStartedAt).getTime() : 0;
      return aTime - bTime;
    }
    case "status":
      return (a.lastExecutionStatus ?? "").localeCompare(b.lastExecutionStatus ?? "");
    default:
      return 0;
  }
}

/**
 * The flat, product-wide traceability matrix (backlog item 6): one row per
 * (requirement, covering test case) pair plus that test case's last execution - a
 * requirement with no covering test case still gets a row, so a coverage gap is something
 * you can literally see, not something you'd have to notice was missing. A plain, real
 * `<table>` (no cards, no divided lists) on purpose: it's meant to be selected and pasted
 * straight into a spreadsheet, and every spreadsheet app understands an HTML table's rows
 * and columns when you paste one in. The "Export CSV" button covers the case where
 * copy-paste isn't convenient (a very long matrix, or wanting a file to attach/email).
 */
export function TraceabilitySection({ productId }: { productId: string }) {
  const matrix = trpc.traceability.getMatrix.useQuery({ productId });
  const reqCustomFieldsQuery = trpc.settings.listCustomFields.useQuery({ entityType: "requirement" });
  const tcCustomFieldsQuery = trpc.settings.listCustomFields.useQuery({ entityType: "test_case" });
  const reqCustomFields = asCustomFieldDefinitions(reqCustomFieldsQuery.data ?? []);
  const tcCustomFields = asCustomFieldDefinitions(tcCustomFieldsQuery.data ?? []);

  // Same URL-driven filter/sort pattern as requirements-section.tsx - see its comment and
  // use-url-state.ts. The exported CSV always reflects the *filtered, sorted* rows - if
  // you narrowed the matrix down to just gaps before exporting, the file matches what you
  // were looking at, not the unfiltered whole.
  const { searchParams, setParams } = useUrlState();
  const statusFilter = searchParams.get("status") ?? ANY;
  const search = searchParams.get("q") ?? "";
  const sortBy = searchParams.get("sortBy");
  const sortDir = searchParams.get("sortDir") === "desc" ? "desc" : "asc";
  const columnIds = useMemo(() => searchParams.get("columns")?.split(",").filter(Boolean) ?? [], [searchParams]);
  const visibleReqFields = useMemo(() => reqCustomFields.filter((f) => columnIds.includes(f.id)), [reqCustomFields, columnIds]);
  const visibleTcFields = useMemo(() => tcCustomFields.filter((f) => columnIds.includes(f.id)), [tcCustomFields, columnIds]);
  // One combined picker for both sides, prefixed so "Req: Risk" and "TC: Risk" (two
  // different fields that happen to share a name across entity types) are still
  // distinguishable in the checklist - the prefix is display-only, not part of the id.
  const pickerFields: CustomFieldDefinitionView[] = useMemo(
    () => [
      ...reqCustomFields.map((f) => ({ ...f, name: `Req: ${f.name}` })),
      ...tcCustomFields.map((f) => ({ ...f, name: `TC: ${f.name}` })),
    ],
    [reqCustomFields, tcCustomFields],
  );

  function onSort(key: string) {
    if (sortBy === key) setParams({ sortDir: sortDir === "asc" ? "desc" : "asc" });
    else setParams({ sortBy: key, sortDir: "asc" });
  }

  const visibleRows = useMemo(() => {
    let rows = matrix.data ?? [];
    if (statusFilter !== ANY) rows = rows.filter((r) => matchesStatusFilter(r, statusFilter));
    if (search.trim()) {
      const needle = search.trim().toLowerCase();
      rows = rows.filter(
        (r) => r.requirementTitle.toLowerCase().includes(needle) || r.testCaseTitle?.toLowerCase().includes(needle),
      );
    }
    if (sortBy) {
      rows = [...rows].sort((a, b) => compareMatrixRows(a, b, sortBy) * (sortDir === "desc" ? -1 : 1));
    }
    return rows;
  }, [matrix.data, statusFilter, search, sortBy, sortDir]);

  function exportCsv() {
    const header = [
      "Requirement ID",
      "Requirement",
      "Level",
      "Test Case ID",
      "Test Case",
      "Last Execution",
      "Environment",
      "Status",
      ...visibleReqFields.map((f) => `Req: ${f.name}`),
      ...visibleTcFields.map((f) => `TC: ${f.name}`),
    ];
    const csvRows = visibleRows.map((r) => [
      formatItemId(r.levelCode, r.requirementSequenceNumber),
      r.requirementTitle,
      r.levelName,
      r.testCaseId ? formatItemId(r.testCaseLevelCode!, r.testCaseSequenceNumber!) : "",
      r.testCaseTitle ?? "Not covered",
      r.lastExecutionStartedAt ? new Date(r.lastExecutionStartedAt).toLocaleString() : "",
      r.lastExecutionEnvironmentName ?? "",
      r.lastExecutionStatus ?? (r.testCaseId ? "Not run" : ""),
      ...visibleReqFields.map((f) =>
        formatCustomFieldValue(
          r.requirementCustomFieldValues.find((v) => v.fieldId === f.id) ?? { fieldType: f.fieldType, value: null, optionLabel: null },
        ),
      ),
      ...visibleTcFields.map((f) =>
        formatCustomFieldValue(
          r.testCaseCustomFieldValues.find((v) => v.fieldId === f.id) ?? { fieldType: f.fieldType, value: null, optionLabel: null },
        ),
      ),
    ]);
    const escape = (cell: string) => `"${cell.replaceAll('"', '""')}"`;
    const csv = [header, ...csvRows].map((row) => row.map((cell) => escape(String(cell))).join(",")).join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "traceability-matrix.csv";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <div className="mb-4 flex items-start justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Every requirement, the test case(s) that cover it, and each one's most recent execution. A blank Test Case
          row means that requirement has no coverage yet.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={exportCsv}
          disabled={!visibleRows.length}
          className="shrink-0 gap-1.5"
        >
          <Download />
          Export CSV
        </Button>
      </div>

      {matrix.isLoading && <p className="text-sm text-muted-foreground">Loading...</p>}
      {matrix.error && <p className="text-sm text-destructive">{matrix.error.message}</p>}

      {!!matrix.data?.length && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Input
            value={search}
            onChange={(e) => setParams({ q: e.target.value || undefined })}
            placeholder="Search requirement or test case..."
            className="h-8 w-64"
          />
          <Select value={statusFilter} onValueChange={(v) => setParams({ status: v === ANY ? undefined : (v ?? undefined) })}>
            <SelectTrigger className="h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Everything</SelectItem>
              <SelectItem value="not_covered">Not covered (gaps)</SelectItem>
              <SelectItem value="never_run">Covered, never run</SelectItem>
              <SelectItem value="pass">Pass</SelectItem>
              <SelectItem value="fail">Fail</SelectItem>
              <SelectItem value="blocked">Blocked</SelectItem>
              <SelectItem value="in_progress">In progress</SelectItem>
            </SelectContent>
          </Select>
          {(statusFilter !== ANY || search) && (
            <Button type="button" variant="ghost" size="sm" onClick={() => setParams({ status: undefined, q: undefined })}>
              Clear filters
            </Button>
          )}
          <CustomFieldColumnPicker
            fields={pickerFields}
            selectedIds={columnIds}
            onChange={(ids) => setParams({ columns: ids.length ? ids.join(",") : undefined })}
          />
        </div>
      )}

      {matrix.data?.length ? (
        <Frame className="bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableTableHead
                  label="ID"
                  sortKey="reqId"
                  activeSortKey={sortBy}
                  direction={sortDir}
                  onSort={onSort}
                  className="w-28"
                />
                <SortableTableHead
                  label="Requirement"
                  sortKey="requirement"
                  activeSortKey={sortBy}
                  direction={sortDir}
                  onSort={onSort}
                />
                <TableHead className="w-28">Test ID</TableHead>
                <SortableTableHead
                  label="Test Case"
                  sortKey="testCase"
                  activeSortKey={sortBy}
                  direction={sortDir}
                  onSort={onSort}
                />
                <SortableTableHead
                  label="Last Execution"
                  sortKey="lastExecution"
                  activeSortKey={sortBy}
                  direction={sortDir}
                  onSort={onSort}
                />
                <SortableTableHead
                  label="Status"
                  sortKey="status"
                  activeSortKey={sortBy}
                  direction={sortDir}
                  onSort={onSort}
                  className="w-28"
                />
                {visibleReqFields.map((f) => (
                  <TableHead key={f.id}>Req: {f.name}</TableHead>
                ))}
                {visibleTcFields.map((f) => (
                  <TableHead key={f.id}>TC: {f.name}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleRows.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={6 + visibleReqFields.length + visibleTcFields.length}
                    className="text-center text-muted-foreground"
                  >
                    No rows match these filters.
                  </TableCell>
                </TableRow>
              )}
              {visibleRows.map((row, i) => (
                <TableRow key={`${row.requirementId}-${row.testCaseId ?? "none"}-${i}`}>
                  <TableCell>
                    <span className="font-mono text-[13px] font-medium text-foreground" title={row.levelName}>
                      {formatItemId(row.levelCode, row.requirementSequenceNumber)}
                    </span>
                  </TableCell>
                  <TableCell className="max-w-xs whitespace-normal">
                    <Link
                      href={`/requirements/${row.requirementId}`}
                      className="text-foreground hover:underline"
                    >
                      {row.requirementTitle}
                    </Link>
                  </TableCell>
                  <TableCell>
                    {row.testCaseId && (
                      <span className="font-mono text-[13px] font-medium text-foreground">
                        {formatItemId(row.testCaseLevelCode!, row.testCaseSequenceNumber!)}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="max-w-xs whitespace-normal">
                    {row.testCaseId ? (
                      <Link
                        href={`/test-cases/${row.testCaseId}`}
                        className="text-foreground hover:underline"
                      >
                        {row.testCaseTitle}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">Not covered</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {row.lastExecutionStartedAt ? (
                      <>
                        {new Date(row.lastExecutionStartedAt).toLocaleDateString()}
                        {row.lastExecutionEnvironmentName ? ` · ${row.lastExecutionEnvironmentName}` : ""}
                      </>
                    ) : row.testCaseId ? (
                      "Never run"
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell>
                    {row.lastExecutionStatus ? <ResultBadge status={row.lastExecutionStatus} /> : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  {visibleReqFields.map((f) => (
                    <TableCell key={f.id} className="text-muted-foreground">
                      {formatCustomFieldValue(
                        row.requirementCustomFieldValues.find((v) => v.fieldId === f.id) ?? {
                          fieldType: f.fieldType,
                          value: null,
                          optionLabel: null,
                        },
                      )}
                    </TableCell>
                  ))}
                  {visibleTcFields.map((f) => (
                    <TableCell key={f.id} className="text-muted-foreground">
                      {formatCustomFieldValue(
                        row.testCaseCustomFieldValues.find((v) => v.fieldId === f.id) ?? {
                          fieldType: f.fieldType,
                          value: null,
                          optionLabel: null,
                        },
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Frame>
      ) : (
        !matrix.isLoading && <p className="text-sm text-muted-foreground">No requirements in this product yet.</p>
      )}
    </div>
  );
}
