"use client";

import { BulkGenerateDocumentButton } from "@/components/bulk-generate-document-button";
import {
  asCustomFieldDefinitions,
  CustomFieldColumnPicker,
  formatCustomFieldValue,
} from "@/components/custom-fields";
import { SortableTableHead } from "@/components/sortable-table-head";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatItemId } from "@/lib/format-item-id";
import { trpc } from "@/lib/trpc-client";
import { useUrlState } from "@/lib/use-url-state";
import Link from "next/link";
import { useMemo, useState } from "react";

const ANY = "any";

interface SortableTestCase {
  sequenceNumber: number;
  title: string;
  coversCount: number;
  createdAt: string | Date;
}

function compareTestCases(a: SortableTestCase, b: SortableTestCase, sortBy: string): number {
  switch (sortBy) {
    case "id":
      return a.sequenceNumber - b.sequenceNumber;
    case "title":
      return a.title.localeCompare(b.title);
    case "covers":
      return a.coversCount - b.coversCount;
    case "created":
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    default:
      return 0;
  }
}

// Level selection is now the ProductContextStrip's job (see requirements-section.tsx's
// identical note) - this just renders the create link + list for the given level.
export function TestCasesSection({ productId, levelId }: { productId: string; levelId: string | null }) {
  const levels = trpc.testCases.listLevels.useQuery();

  const testCases = trpc.testCases.listByProduct.useQuery(
    { productId, levelId: levelId! },
    { enabled: !!levelId },
  );
  const customFieldsQuery = trpc.settings.listCustomFields.useQuery({ entityType: "test_case" });
  const customFields = asCustomFieldDefinitions(customFieldsQuery.data ?? []);

  // Same URL-driven filter/sort pattern as requirements-section.tsx - see its comment and
  // use-url-state.ts.
  const { searchParams, setParams } = useUrlState();
  const search = searchParams.get("q") ?? "";
  const sortBy = searchParams.get("sortBy");
  const sortDir = searchParams.get("sortDir") === "desc" ? "desc" : "asc";
  const columnIds = useMemo(() => searchParams.get("columns")?.split(",").filter(Boolean) ?? [], [searchParams]);
  const visibleCustomFields = useMemo(
    () => customFields.filter((f) => columnIds.includes(f.id)),
    [customFields, columnIds],
  );

  function onSort(key: string) {
    if (sortBy === key) setParams({ sortDir: sortDir === "asc" ? "desc" : "asc" });
    else setParams({ sortBy: key, sortDir: "asc" });
  }

  const visibleTestCases = useMemo(() => {
    let rows = testCases.data ?? [];
    if (search.trim()) {
      const needle = search.trim().toLowerCase();
      rows = rows.filter((tc) => tc.title.toLowerCase().includes(needle));
    }
    if (sortBy) {
      rows = [...rows].sort((a, b) => compareTestCases(a, b, sortBy) * (sortDir === "desc" ? -1 : 1));
    }
    return rows;
  }, [testCases.data, search, sortBy, sortDir]);

  // Bulk selection for "generate a report per selected test case, zipped" (backlog item
  // 9.32) - independent of the filters above (a selected row stays selected if it's
  // filtered out, rather than silently losing the selection), but "select all" only ever
  // acts on what's currently visible.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const allVisibleSelected = visibleTestCases.length > 0 && visibleTestCases.every((tc) => selectedIds.has(tc.id));
  function toggleOne(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAllVisible() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) for (const tc of visibleTestCases) next.delete(tc.id);
      else for (const tc of visibleTestCases) next.add(tc.id);
      return next;
    });
  }

  if (levels.isLoading || !levelId) return <p className="text-sm text-muted-foreground">Loading...</p>;

  return (
    <>
      <div className="mb-6">
        <Link href={`/products/${productId}/test-cases/new?levelId=${levelId}`} className={buttonVariants()}>
          New test case
        </Link>
      </div>

      {testCases.isLoading && <p className="text-sm text-muted-foreground">Loading...</p>}
      {testCases.error && <p className="text-sm text-destructive">{testCases.error.message}</p>}

      {!!testCases.data?.length && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Input
            value={search}
            onChange={(e) => setParams({ q: e.target.value || undefined })}
            placeholder="Search title..."
            className="h-8 w-48"
          />
          {search && (
            <Button type="button" variant="ghost" size="sm" onClick={() => setParams({ q: undefined })}>
              Clear filters
            </Button>
          )}
          <CustomFieldColumnPicker
            fields={customFields}
            selectedIds={columnIds}
            onChange={(ids) => setParams({ columns: ids.length ? ids.join(",") : undefined })}
          />
        </div>
      )}

      {selectedIds.size > 0 && (
        <div className="mb-3">
          <BulkGenerateDocumentButton
            scope="test_case"
            ids={[...selectedIds]}
            onDone={() => setSelectedIds(new Set())}
          />
        </div>
      )}

      {testCases.data?.length ? (
        <div className="overflow-hidden rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  <input
                    type="checkbox"
                    className="accent-primary"
                    checked={allVisibleSelected}
                    onChange={toggleAllVisible}
                    aria-label="Select all visible test cases"
                  />
                </TableHead>
                <SortableTableHead label="ID" sortKey="id" activeSortKey={sortBy} direction={sortDir} onSort={onSort} />
                <SortableTableHead label="Title" sortKey="title" activeSortKey={sortBy} direction={sortDir} onSort={onSort} />
                <SortableTableHead
                  label="Covers"
                  sortKey="covers"
                  activeSortKey={sortBy}
                  direction={sortDir}
                  onSort={onSort}
                />
                <SortableTableHead
                  label="Created"
                  sortKey="created"
                  activeSortKey={sortBy}
                  direction={sortDir}
                  onSort={onSort}
                />
                {visibleCustomFields.map((f) => (
                  <TableHead key={f.id}>{f.name}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleTestCases.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5 + visibleCustomFields.length} className="text-center text-muted-foreground">
                    No test cases match these filters.
                  </TableCell>
                </TableRow>
              )}
              {visibleTestCases.map((tc) => (
                <TableRow key={tc.id}>
                  <TableCell>
                    <input
                      type="checkbox"
                      className="accent-primary"
                      checked={selectedIds.has(tc.id)}
                      onChange={() => toggleOne(tc.id)}
                      aria-label={`Select ${tc.title}`}
                    />
                  </TableCell>
                  <TableCell>
                    <span className="font-mono text-xs font-semibold text-primary" title={tc.id}>
                      {formatItemId(tc.levelCode, tc.sequenceNumber)}
                    </span>
                  </TableCell>
                  <TableCell className="max-w-sm whitespace-normal">
                    <Link
                      href={`/test-cases/${tc.id}`}
                      className="font-medium text-primary underline-offset-2 hover:underline"
                    >
                      {tc.title}
                    </Link>
                  </TableCell>
                  <TableCell>
                    {tc.coversCount > 0 ? (
                      <Link
                        href={`/products/${productId}?artifact=traceability`}
                        className="text-primary underline-offset-2 hover:underline"
                      >
                        {tc.coversCount} req{tc.coversCount === 1 ? "" : "s"}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {new Date(tc.createdAt).toLocaleDateString()}
                  </TableCell>
                  {visibleCustomFields.map((f) => (
                    <TableCell key={f.id} className="text-muted-foreground">
                      {formatCustomFieldValue(
                        tc.customFieldValues.find((v) => v.fieldId === f.id) ?? {
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
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No test cases at this level yet - create one above.</p>
      )}
    </>
  );
}
