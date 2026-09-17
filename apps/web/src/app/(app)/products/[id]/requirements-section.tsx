"use client";

import {
  asCustomFieldDefinitions,
  type CustomFieldFormState,
  CustomFieldColumnPicker,
  CustomFieldInputs,
  formatCustomFieldValue,
  toCustomFieldValuesInput,
} from "@/components/custom-fields";
import { Frame } from "@/components/frame";
import { GenerateDocumentButton } from "@/components/generate-document-button";
import { SortableTableHead } from "@/components/sortable-table-head";
import { StatusPill } from "@/components/status-pill";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { formatItemId } from "@/lib/format-item-id";
import { trpc } from "@/lib/trpc-client";
import { useUrlState } from "@/lib/use-url-state";
import { Plus } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useMemo, useState } from "react";

/** TipTap is multi-MB; only needed when the create form is open, so keep it out of the
 * requirements list chunk until then. */
const RichTextEditor = dynamic(
  () => import("@/components/rich-text-editor").then((m) => m.RichTextEditor),
  { ssr: false, loading: () => <p className="text-sm text-muted-foreground">Loading editor…</p> },
);

const ANY = "any";

interface SortableRequirement {
  sequenceNumber: number;
  title: string;
  versionNumber: number;
  statusName: string;
  coveredByCount: number;
}

function compareRequirements(a: SortableRequirement, b: SortableRequirement, sortBy: string): number {
  switch (sortBy) {
    case "id":
      return a.sequenceNumber - b.sequenceNumber;
    case "title":
      return a.title.localeCompare(b.title);
    case "version":
      return a.versionNumber - b.versionNumber;
    case "status":
      return a.statusName.localeCompare(b.statusName);
    case "covered":
      return a.coveredByCount - b.coveredByCount;
    default:
      return 0;
  }
}

// Base UI's Select (unlike a native <select>) doesn't allow an item with value="" - it's
// reserved to mean "no selection". "none" is the sentinel for the optional parent
// dropdown here, translated back to undefined at the point it's actually used.
const NO_PARENT = "none";

// Level selection is now the ProductContextStrip's job (the tabs live in the top bar,
// driven by the ?level= query param) - this component just renders the create form + list
// for whichever level the page hands it.
export function RequirementsSection({ productId, levelId }: { productId: string; levelId: string | null }) {
  const levels = trpc.requirements.listLevels.useQuery();
  // Same query the context strip's product switcher already makes - TanStack Query
  // dedupes it by key, so this doesn't add a second network request.
  const products = trpc.products.list.useQuery();
  const productName = products.data?.find((p) => p.id === productId)?.name ?? "Product";

  const utils = trpc.useUtils();
  const requirements = trpc.requirements.listByProduct.useQuery(
    { productId, levelId: levelId! },
    { enabled: !!levelId },
  );
  const parentCandidates = trpc.requirements.listParentCandidates.useQuery(
    { productId, levelId: levelId! },
    { enabled: !!levelId },
  );

  const statuses = trpc.requirements.listStatuses.useQuery();
  const customFieldsQuery = trpc.settings.listCustomFields.useQuery({ entityType: "requirement" });
  const customFields = useMemo(() => asCustomFieldDefinitions(customFieldsQuery.data ?? []), [customFieldsQuery.data]);
  // Safety Classification is a plain pre-seeded custom field now (see
  // packages/core/src/custom-fields.ts's seedDefaultCustomFields) - looked up by name,
  // not assumed to exist, since a tenant can rename or delete it like any other field.
  const safetyClassField = useMemo(() => customFields.find((f) => f.name === "Safety Classification"), [customFields]);

  const createRequirement = trpc.requirements.create.useMutation({
    onSuccess: () => utils.requirements.listByProduct.invalidate({ productId, levelId: levelId! }),
  });

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [background, setBackground] = useState("");
  const [parentRequirementId, setParentRequirementId] = useState(NO_PARENT);
  const [customFieldState, setCustomFieldState] = useState<CustomFieldFormState>({});
  // Starts closed - a "+ New {level}" button opens it on demand, rather than the form
  // always sitting open ahead of the list.
  const [showCreateForm, setShowCreateForm] = useState(false);

  // Filter/sort state lives in the URL, not component state - see use-url-state.ts - so a
  // filtered, sorted view is a real link a reviewer can be sent directly to. Filtering and
  // sorting themselves happen client-side over the already-fetched list (it's not paginated
  // - the whole level's requirements come back in one call already), rather than pushing
  // these as query params to the backend.
  const { searchParams, setParams } = useUrlState();
  const statusFilter = searchParams.get("status") ?? ANY;
  const search = searchParams.get("q") ?? "";
  const sortBy = searchParams.get("sortBy");
  const sortDir = searchParams.get("sortDir") === "desc" ? "desc" : "asc";
  // Which custom-field columns to show, comma-separated field ids - same URL-state
  // approach as every other filter/sort here, so a chosen set of columns is a shareable
  // link too, not per-viewer local state.
  const columnIds = useMemo(() => searchParams.get("columns")?.split(",").filter(Boolean) ?? [], [searchParams]);
  const visibleCustomFields = useMemo(
    () => customFields.filter((f) => columnIds.includes(f.id)),
    [customFields, columnIds],
  );

  function onSort(key: string) {
    if (sortBy === key) setParams({ sortDir: sortDir === "asc" ? "desc" : "asc" });
    else setParams({ sortBy: key, sortDir: "asc" });
  }

  const visibleRequirements = useMemo(() => {
    let rows = requirements.data ?? [];
    if (statusFilter !== ANY) rows = rows.filter((r) => r.statusName === statusFilter);
    if (search.trim()) {
      const needle = search.trim().toLowerCase();
      rows = rows.filter((r) => r.title.toLowerCase().includes(needle));
    }
    if (sortBy) {
      rows = [...rows].sort((a, b) => compareRequirements(a, b, sortBy) * (sortDir === "desc" ? -1 : 1));
    }
    return rows;
  }, [requirements.data, statusFilter, search, sortBy, sortDir]);

  // Every number here comes from data already fetched above - no new endpoint.
  const summary = useMemo(() => {
    const all = requirements.data ?? [];
    if (all.length === 0) return null;
    const covered = all.filter((r) => r.coveredByCount > 0).length;
    return { total: all.length, covered };
  }, [requirements.data]);

  if (levels.isLoading || !levelId) return <p className="text-[13.5px] text-muted-foreground">Loading...</p>;

  const levelName = levels.data?.find((l) => l.id === levelId)?.name ?? "requirement";

  return (
    <div className="p-6">
      <div className="flex items-end justify-between gap-6">
        <div>
          <p className="font-mono text-[10.5px] tracking-[0.14em] text-muted-foreground uppercase">
            {productName} / {levelName}
          </p>
          <h2 className="mt-0.5 font-heading text-[34px] leading-[1.05] tracking-tight">{levelName}</h2>
        </div>
        <div className="flex gap-2">
          <GenerateDocumentButton
            scope="requirement_list"
            buildRequestBody={() => ({ requirementIds: visibleRequirements.map((r) => r.id), productId, levelId })}
          />
          <Button type="button" variant="outline" onClick={() => setShowCreateForm((v) => !v)}>
            <Plus />
            New {levelName}
          </Button>
        </div>
      </div>

      {summary && (
        <div className="mt-4.5 grid grid-cols-2 border border-border bg-card">
          <SummaryCell label="Total" value={summary.total} />
          <SummaryCell label="Covered" value={summary.covered} of={summary.total} last />
        </div>
      )}

      {showCreateForm && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            createRequirement.mutate(
              {
                productId,
                levelId,
                parentRequirementId: parentRequirementId === NO_PARENT ? undefined : parentRequirementId,
                title,
                description,
                background: background || undefined,
                customFieldValues: toCustomFieldValuesInput(customFieldState),
              },
              {
                onSuccess: () => {
                  setTitle("");
                  setDescription("");
                  setBackground("");
                  setParentRequirementId(NO_PARENT);
                  setCustomFieldState({});
                  setShowCreateForm(false);
                },
              },
            );
          }}
          className="mt-4.5 space-y-3 border border-border bg-card p-4"
        >
          <h3 className="font-heading text-[13px] tracking-[0.14em] text-muted-foreground uppercase">New {levelName}</h3>
          {!!parentCandidates.data?.length && (
            <Select value={parentRequirementId} onValueChange={(v) => setParentRequirementId(v ?? NO_PARENT)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_PARENT}>No parent</SelectItem>
                {parentCandidates.data.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {formatItemId(c.levelCode, c.sequenceNumber)}: {c.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Input required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" />
          <Textarea
            required
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description"
            rows={3}
          />
          <Label className="flex-col items-start gap-1">
            <span className="text-xs font-medium text-muted-foreground">Background (optional)</span>
            <RichTextEditor value={background} onChange={setBackground} />
          </Label>
          <CustomFieldInputs
            fields={customFields}
            state={customFieldState}
            onChange={(fieldId, value) => setCustomFieldState((s) => ({ ...s, [fieldId]: value }))}
          />
          {createRequirement.error && <p className="text-sm text-destructive">{createRequirement.error.message}</p>}
          <div className="flex gap-2">
            <Button type="submit" disabled={createRequirement.isPending}>
              {createRequirement.isPending ? "Creating..." : `Create ${levelName}`}
            </Button>
            <Button type="button" variant="outline" onClick={() => setShowCreateForm(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {requirements.isLoading && <p className="mt-4 text-[13.5px] text-muted-foreground">Loading...</p>}
      {requirements.error && <p className="mt-4 text-sm text-destructive">{requirements.error.message}</p>}

      {!!requirements.data?.length && (
        <div className="mt-4.5 flex flex-wrap items-center gap-2">
          <div className="flex w-[250px] items-center gap-1.5 border border-border bg-card px-2.5 py-[5px]">
            <SearchIcon />
            <input
              value={search}
              onChange={(e) => setParams({ q: e.target.value || undefined })}
              placeholder="Search title or id…"
              className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <FilterSelect
            label="Status"
            value={statusFilter}
            active={statusFilter !== ANY}
            onValueChange={(v) => setParams({ status: v === ANY ? undefined : (v ?? undefined) })}
          >
            <SelectItem value={ANY}>All</SelectItem>
            {statuses.data?.map((s) => (
              <SelectItem key={s.id} value={s.name}>
                {s.name}
              </SelectItem>
            ))}
          </FilterSelect>
          {(statusFilter !== ANY || search) && (
            <Button type="button" variant="ghost" size="sm" onClick={() => setParams({ status: undefined, q: undefined })}>
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

      {requirements.data?.length ? (
        <Frame className="mt-3.5 bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableTableHead label="ID" sortKey="id" activeSortKey={sortBy} direction={sortDir} onSort={onSort} className="w-[92px]" />
                <SortableTableHead label="Requirement" sortKey="title" activeSortKey={sortBy} direction={sortDir} onSort={onSort} />
                <TableHead className="w-[70px]">Class</TableHead>
                <SortableTableHead label="Ver" sortKey="version" activeSortKey={sortBy} direction={sortDir} onSort={onSort} className="w-[58px]" />
                <SortableTableHead label="Status" sortKey="status" activeSortKey={sortBy} direction={sortDir} onSort={onSort} className="w-[118px]" />
                <TableHead className="w-[210px]">Traces to</TableHead>
                <SortableTableHead label="Coverage" sortKey="covered" activeSortKey={sortBy} direction={sortDir} onSort={onSort} className="w-[150px]" />
                {visibleCustomFields.map((f) => (
                  <TableHead key={f.id}>{f.name}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleRequirements.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7 + visibleCustomFields.length} className="text-center text-muted-foreground">
                    No requirements match these filters.
                  </TableCell>
                </TableRow>
              )}
              {visibleRequirements.map((r) => {
                const safetyClass = safetyClassField
                  ? r.customFieldValues.find((v) => v.fieldId === safetyClassField.id)?.optionLabel
                  : null;
                return (
                  <TableRow key={r.id}>
                    <TableCell>
                      <Link href={`/requirements/${r.id}`} className="font-mono text-[13px] font-medium text-foreground">
                        {formatItemId(r.levelCode, r.sequenceNumber)}
                      </Link>
                    </TableCell>
                    <TableCell className="max-w-xs whitespace-normal">
                      <Link href={`/requirements/${r.id}`} className="text-foreground hover:underline">
                        {r.title}
                      </Link>
                    </TableCell>
                    <TableCell>
                      {safetyClass ? (
                        <span
                          className={
                            safetyClass === "C"
                              ? "bg-foreground px-1.5 font-mono text-xs font-medium text-background"
                              : "font-mono text-xs font-medium"
                          }
                        >
                          {safetyClass}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-[12.5px] text-muted-foreground">v{r.versionNumber}</TableCell>
                    <TableCell>
                      <StatusPill category={r.statusCategory} name={r.statusName} />
                    </TableCell>
                    <TableCell className="max-w-[210px] truncate text-muted-foreground">
                      {r.parentTitle && r.parentRequirementId ? (
                        <Link href={`/requirements/${r.parentRequirementId}`} className="hover:text-foreground" title={r.parentTitle}>
                          {r.parentTitle}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell>
                      {r.coveredByCount > 0 ? (
                        <Link href={`/products/${productId}?artifact=traceability`} className="text-foreground hover:underline">
                          {r.coveredByCount} test{r.coveredByCount === 1 ? "" : "s"}
                        </Link>
                      ) : (
                        <span className="flex items-center gap-1.5 text-[#2c455d]">
                          <NoCoverageIcon />
                          No coverage
                        </span>
                      )}
                    </TableCell>
                    {visibleCustomFields.map((f) => (
                      <TableCell key={f.id} className="text-muted-foreground">
                        {formatCustomFieldValue(
                          r.customFieldValues.find((v) => v.fieldId === f.id) ?? { fieldType: f.fieldType, value: null, optionLabel: null },
                        )}
                      </TableCell>
                    ))}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Frame>
      ) : (
        <p className="mt-4 text-[13.5px] text-muted-foreground">No requirements at this level yet - create one above.</p>
      )}

      {!!requirements.data?.length && (
        <p className="mt-2.5 text-[12.5px] text-muted-foreground">
          Showing {visibleRequirements.length} of {requirements.data.length}
        </p>
      )}
    </div>
  );
}

function SummaryCell({ label, value, of, last }: { label: string; value: number; of?: number; last?: boolean }) {
  return (
    <div className={`p-3.5 ${last ? "" : "border-r border-border"}`}>
      <p className="font-mono text-[10.5px] tracking-[0.1em] text-muted-foreground uppercase">{label}</p>
      <p className="mt-0.5 font-heading text-[26px] leading-none">
        {value}
        {of != null && <span className="text-sm text-muted-foreground"> / {of}</span>}
      </p>
      {of != null && of > 0 && (
        <div className="mt-2 flex h-1 gap-px">
          <span className="bg-primary" style={{ flex: value }} />
          <span className="bg-foreground/18" style={{ flex: Math.max(of - value, 0.0001) }} />
        </div>
      )}
    </div>
  );
}

/** A Select restyled as the handoff's filter chip - "Status: All" with the trigger's own
 * chevron, or (once a real filter is applied) an accent border/tint fill/tinted text.
 * `label` is a static prefix (`Status:`), not part of the Select's own value. */
function FilterSelect({
  label,
  value,
  active,
  onValueChange,
  children,
}: {
  label: string;
  value: string;
  active: boolean;
  onValueChange: (v: string | null) => void;
  children: React.ReactNode;
}) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger
        className={
          active
            ? "gap-1.5 border-primary bg-[rgba(89,128,166,.12)] px-2.5 py-[5px] text-sm text-[#2c455d]"
            : "gap-1.5 border-border bg-card px-2.5 py-[5px] text-sm text-muted-foreground"
        }
      >
        <span>
          {label}: <span className={active ? "font-medium" : "font-medium text-foreground"}>{value === ANY ? "All" : value}</span>
        </span>
      </SelectTrigger>
      <SelectContent>{children}</SelectContent>
    </Select>
  );
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="text-muted-foreground">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

function NoCoverageIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    </svg>
  );
}
