"use client";

import { BulkGenerateDocumentButton } from "@/components/bulk-generate-document-button";
import { ColumnPicker } from "@/components/column-picker";
import {
  asCustomFieldDefinitions,
  formatCustomFieldValue,
} from "@/components/custom-fields";
import { DebouncedSearchInput } from "@/components/debounced-search-input";
import { FilterChip } from "@/components/filter-chip";
import { Frame } from "@/components/frame";
import { SortableTableHead } from "@/components/sortable-table-head";
import { Button, buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatItemId } from "@/lib/format-item-id";
import { parseColumnParam, serializeColumnParam, type ListColumn } from "@/lib/column-visibility";
import { type FilterDef, useListFilters } from "@/lib/list-filters";
import { trpc } from "@/lib/trpc-client";
import { useUrlState } from "@/lib/use-url-state";
import { Plus } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

const BUILTIN_COLUMNS: ListColumn[] = [
  { id: "id", label: "ID", required: true },
  { id: "title", label: "Test case" },
  { id: "covers", label: "Covers" },
  { id: "architecture", label: "Software items", defaultVisible: false },
  { id: "versions", label: "Versions", defaultVisible: false },
  { id: "created", label: "Created" },
];

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
  // Same query the context strip's product switcher already makes - TanStack Query
  // dedupes it by key, so this doesn't add a second network request.
  const products = trpc.products.list.useQuery();
  const productName = products.data?.find((p) => p.id === productId)?.name ?? "Product";

  const testCases = trpc.testCases.listByProduct.useQuery(
    { productId, levelId: levelId! },
    { enabled: !!levelId },
  );
  const softwareVersionOptions = trpc.softwareVersions.listByProduct.useQuery({ productId });
  const customFieldsQuery = trpc.settings.listCustomFields.useQuery({ entityType: "test_case" });
  const customFields = asCustomFieldDefinitions(customFieldsQuery.data ?? []);
  const columns = useMemo<ListColumn[]>(
    () => [
      ...BUILTIN_COLUMNS,
      ...customFields.map((f) => ({ id: f.id, label: f.name, defaultVisible: false })),
    ],
    [customFields],
  );

  // Same URL-driven filter/sort pattern as requirements-section.tsx - see its comment and
  // use-url-state.ts.
  const { searchParams, setParams } = useUrlState();
  const search = searchParams.get("q") ?? "";
  const sortBy = searchParams.get("sortBy");
  const sortDir = searchParams.get("sortDir") === "desc" ? "desc" : "asc";
  // Declarative filters - see list-filters.ts (same pattern as requirements-section.tsx).
  const filterDefs = useMemo<FilterDef<NonNullable<typeof testCases.data>[number]>[]>(
    () => [
      {
        id: "version",
        label: "Version",
        options: (softwareVersionOptions.data ?? []).map((v) => ({ value: v.id, label: v.versionNumber })),
        matches: (tc, v) => tc.softwareVersions.some((sv) => sv.id === v),
      },
    ],
    [softwareVersionOptions.data],
  );
  const filters = useListFilters(filterDefs);
  const columnIds = useMemo(
    () => parseColumnParam(searchParams.get("columns"), columns),
    [searchParams, columns],
  );
  const visible = useMemo(() => new Set(columnIds), [columnIds]);
  const visibleCustomFields = useMemo(
    () => customFields.filter((f) => visible.has(f.id)),
    [customFields, visible],
  );

  function onSort(key: string) {
    if (sortBy === key) setParams({ sortDir: sortDir === "asc" ? "desc" : "asc" });
    else setParams({ sortBy: key, sortDir: "asc" });
  }

  const visibleTestCases = useMemo(() => {
    let rows = testCases.data ?? [];
    rows = filters.applyFilters(rows);
    if (search.trim()) {
      const needle = search.trim().toLowerCase();
      rows = rows.filter((tc) => tc.title.toLowerCase().includes(needle));
    }
    if (sortBy) {
      rows = [...rows].sort((a, b) => compareTestCases(a, b, sortBy) * (sortDir === "desc" ? -1 : 1));
    }
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [testCases.data, filters.active, search, sortBy, sortDir]);

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

  if (levels.isLoading || !levelId) return <p className="p-6 text-[13.5px] text-muted-foreground">Loading...</p>;

  const levelName = levels.data?.find((l) => l.id === levelId)?.name ?? "Test Cases";

  return (
    <div className="p-6">
      <div className="flex items-end justify-between gap-6">
        <div>
          <p className="font-mono text-[10.5px] tracking-[0.14em] text-muted-foreground uppercase">
            {productName} / {levelName}
          </p>
          <h2 className="mt-0.5 font-heading text-[34px] leading-[1.05] tracking-tight">{levelName}</h2>
        </div>
        <Link href={`/products/${productId}/test-cases/new?levelId=${levelId}`} className={buttonVariants({ className: "gap-1.5" })}>
          <Plus className="size-3.5" />
          New test case
        </Link>
      </div>

      {testCases.isLoading && <p className="mt-4 text-[13.5px] text-muted-foreground">Loading...</p>}
      {testCases.error && <p className="mt-4 text-sm text-destructive">{testCases.error.message}</p>}

      {!!testCases.data?.length && (
        <div className="mt-4.5 flex flex-wrap items-center gap-2">
          <div className="flex w-[250px] items-center gap-1.5 border border-border bg-card px-2.5 py-[5px]">
            <DebouncedSearchInput
              value={search}
              onChange={(v) => setParams({ q: v || undefined })}
              placeholder="Search title or id…"
              className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          {filterDefs.map((def) => (
            <FilterChip key={def.id} def={def} value={filters.active[def.id]} onChange={(v) => filters.setFilter(def.id, v)} />
          ))}
          {(filters.hasActive || search) && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                filters.clearAll();
                setParams({ q: undefined });
              }}
            >
              Clear filters
            </Button>
          )}
          <ColumnPicker
            columns={columns}
            selectedIds={columnIds}
            onChange={(ids) => setParams({ columns: serializeColumnParam(ids, columns) })}
          />
        </div>
      )}

      {selectedIds.size > 0 && (
        <div className="mt-3">
          <BulkGenerateDocumentButton
            scope="test_case"
            ids={[...selectedIds]}
            onDone={() => setSelectedIds(new Set())}
          />
        </div>
      )}

      {testCases.data?.length ? (
        <Frame className="mt-3.5 bg-card">
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
                {visible.has("id") && (
                  <SortableTableHead label="ID" sortKey="id" activeSortKey={sortBy} direction={sortDir} onSort={onSort} className="w-[92px]" />
                )}
                {visible.has("title") && (
                  <SortableTableHead label="Test case" sortKey="title" activeSortKey={sortBy} direction={sortDir} onSort={onSort} />
                )}
                {visible.has("covers") && (
                  <SortableTableHead label="Covers" sortKey="covers" activeSortKey={sortBy} direction={sortDir} onSort={onSort} className="w-[130px]" />
                )}
                {visible.has("architecture") && <TableHead className="w-[160px]">Architecture</TableHead>}
                {visible.has("versions") && <TableHead className="w-[140px]">Versions</TableHead>}
                {visible.has("created") && (
                  <SortableTableHead label="Created" sortKey="created" activeSortKey={sortBy} direction={sortDir} onSort={onSort} className="w-[110px]" />
                )}
                {visibleCustomFields.map((f) => (
                  <TableHead key={f.id}>{f.name}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleTestCases.length === 0 && (
                <TableRow>
                  <TableCell colSpan={Math.max(columnIds.length + 1, 1)} className="text-center text-muted-foreground">
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
                  {visible.has("id") && (
                    <TableCell>
                      <Link href={`/test-cases/${tc.id}`} className="font-mono text-[13px] font-medium text-foreground">
                        {formatItemId(tc.levelCode, tc.sequenceNumber)}
                      </Link>
                    </TableCell>
                  )}
                  {visible.has("title") && (
                    <TableCell className="max-w-sm whitespace-normal">
                      <Link href={`/test-cases/${tc.id}`} className="text-foreground hover:underline">
                        {tc.title}
                      </Link>
                    </TableCell>
                  )}
                  {visible.has("covers") && (
                    <TableCell>
                      {tc.coversCount > 0 ? (
                        <Link href={`/products/${productId}?artifact=traceability`} className="text-foreground hover:underline">
                          {tc.coversCount} req{tc.coversCount === 1 ? "" : "s"}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  )}
                  {visible.has("architecture") && (
                    <TableCell className="max-w-[160px] truncate font-mono text-[12.5px] text-muted-foreground">
                      {tc.architectureLinks.length > 0 ? tc.architectureLinks.join(", ") : "—"}
                    </TableCell>
                  )}
                  {visible.has("versions") && (
                    <TableCell className="max-w-[140px] truncate text-[12.5px] text-muted-foreground">
                      {tc.softwareVersions.length > 0 ? tc.softwareVersions.map((v) => v.versionNumber).join(", ") : "—"}
                    </TableCell>
                  )}
                  {visible.has("created") && (
                    <TableCell className="text-muted-foreground">{new Date(tc.createdAt).toLocaleDateString()}</TableCell>
                  )}
                  {visibleCustomFields.map((f) => (
                    <TableCell key={f.id} className="text-muted-foreground">
                      {formatCustomFieldValue(
                        tc.customFieldValues.find((v) => v.fieldId === f.id) ?? { fieldType: f.fieldType, value: null, optionLabel: null },
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Frame>
      ) : (
        <p className="mt-4 text-[13.5px] text-muted-foreground">No test cases at this level yet - create one above.</p>
      )}

      {!!testCases.data?.length && (
        <p className="mt-2.5 text-[12.5px] text-muted-foreground">
          Showing {visibleTestCases.length} of {testCases.data.length}
        </p>
      )}
    </div>
  );
}
