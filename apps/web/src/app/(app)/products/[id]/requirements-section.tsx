"use client";

import {
  asCustomFieldDefinitions,
  type CustomFieldFormState,
  CustomFieldColumnPicker,
  CustomFieldInputs,
  formatCustomFieldValue,
  toCustomFieldValuesInput,
} from "@/components/custom-fields";
import { GenerateDocumentButton } from "@/components/generate-document-button";
import { RichTextEditor } from "@/components/rich-text-editor";
import { SortableTableHead } from "@/components/sortable-table-head";
import { StatusPill } from "@/components/status-pill";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { formatItemId } from "@/lib/format-item-id";
import { trpc } from "@/lib/trpc-client";
import { useUrlState } from "@/lib/use-url-state";
import { Plus } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

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

  if (levels.isLoading || !levelId) return <p className="text-sm text-muted-foreground">Loading...</p>;

  const levelName = levels.data?.find((l) => l.id === levelId)?.name ?? "requirement";

  return (
    <>
      {showCreateForm ? (
        <Card className="mb-10 p-4">
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
                  },
                },
              );
            }}
            className="space-y-3"
          >
            <h2 className="text-sm font-medium text-foreground">New {levelName}</h2>
            <div className="flex gap-3">
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
            </div>
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
                {createRequirement.isPending ? "Creating..." : "Create requirement"}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setShowCreateForm(false)}>
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      ) : (
        <Button type="button" variant="outline" className="mb-10 gap-1" onClick={() => setShowCreateForm(true)}>
          <Plus />
          New {levelName}
        </Button>
      )}

      {requirements.isLoading && <p className="text-sm text-muted-foreground">Loading...</p>}
      {requirements.error && <p className="text-sm text-destructive">{requirements.error.message}</p>}

      {!!requirements.data?.length && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Input
            value={search}
            onChange={(e) => setParams({ q: e.target.value || undefined })}
            placeholder="Search title..."
            className="h-8 w-48"
          />
          <Select value={statusFilter} onValueChange={(v) => setParams({ status: v === ANY ? undefined : (v ?? undefined) })}>
            <SelectTrigger className="h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>All statuses</SelectItem>
              {statuses.data?.map((s) => (
                <SelectItem key={s.id} value={s.name}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {(statusFilter !== ANY || search) && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setParams({ status: undefined, q: undefined })}
            >
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

      <div className="mb-3">
        <GenerateDocumentButton
          scope="requirement_list"
          buildRequestBody={() => ({
            requirementIds: visibleRequirements.map((r) => r.id),
            productId,
            levelId,
          })}
        />
      </div>

      {requirements.data?.length ? (
        <div className="overflow-hidden rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableTableHead label="ID" sortKey="id" activeSortKey={sortBy} direction={sortDir} onSort={onSort} />
                <SortableTableHead label="Title" sortKey="title" activeSortKey={sortBy} direction={sortDir} onSort={onSort} />
                <SortableTableHead
                  label="Version"
                  sortKey="version"
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
                />
                <TableHead>Traces to</TableHead>
                <SortableTableHead
                  label="Covered by"
                  sortKey="covered"
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
              {visibleRequirements.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6 + visibleCustomFields.length} className="text-center text-muted-foreground">
                    No requirements match these filters.
                  </TableCell>
                </TableRow>
              )}
              {visibleRequirements.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <span className="font-mono text-xs font-semibold text-primary" title={r.id}>
                      {formatItemId(r.levelCode, r.sequenceNumber)}
                    </span>
                  </TableCell>
                  <TableCell className="max-w-xs whitespace-normal">
                    <Link
                      href={`/requirements/${r.id}`}
                      className="font-medium text-primary underline-offset-2 hover:underline"
                    >
                      {r.title}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <span className="font-mono font-semibold text-primary">v{r.versionNumber}</span>
                  </TableCell>
                  <TableCell>
                    <StatusPill category={r.statusCategory} name={r.statusName} />
                  </TableCell>
                  <TableCell className="max-w-xs truncate">
                    {r.parentTitle && r.parentRequirementId ? (
                      <Link
                        href={`/requirements/${r.parentRequirementId}`}
                        className="text-primary underline-offset-2 hover:underline"
                        title={r.parentTitle}
                      >
                        {r.parentTitle}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {r.coveredByCount > 0 ? (
                      <Link
                        href={`/products/${productId}?artifact=traceability`}
                        className="text-primary underline-offset-2 hover:underline"
                      >
                        {r.coveredByCount} test{r.coveredByCount === 1 ? "" : "s"}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">— no coverage</span>
                    )}
                  </TableCell>
                  {visibleCustomFields.map((f) => (
                    <TableCell key={f.id} className="text-muted-foreground">
                      {formatCustomFieldValue(
                        r.customFieldValues.find((v) => v.fieldId === f.id) ?? {
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
        <p className="text-sm text-muted-foreground">No requirements at this level yet - create one above.</p>
      )}
    </>
  );
}
