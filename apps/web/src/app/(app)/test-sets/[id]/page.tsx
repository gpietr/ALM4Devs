"use client";

import { ProductContextStrip } from "@/components/context-strip";
import {
  asCustomFieldDefinitions,
  type CustomFieldFormState,
  type CustomFieldValueView,
  CustomFieldInputs,
  emptyCustomFieldFormState,
  formatCustomFieldValue,
  toCustomFieldValuesInput,
} from "@/components/custom-fields";
import { Frame } from "@/components/frame";
import { ResultBadge } from "@/components/result-badge";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxInputGroup,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxPortal,
  ComboboxPositioner,
} from "@/components/ui/combobox";
import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { entryHref } from "@/lib/product-nav";
import { formatItemId } from "@/lib/format-item-id";
import { trpc } from "@/lib/trpc-client";
import { ChevronDown, ChevronUp } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useEffect, useMemo, useRef, useState } from "react";

const STATUS_ORDER = ["not_run", "in_progress", "pass", "fail", "blocked", "abandoned"] as const;

interface TestCaseOption {
  id: string;
  title: string;
  levelName: string;
  levelCode: string;
  sequenceNumber: number;
}

interface LastExecution {
  id: string;
  status: string;
  startedAt: string | Date;
  completedAt: string | Date | null;
  executedByName: string;
}

interface TestSetItem {
  id: string;
  sortOrder: number;
  testCaseId: string;
  testCaseTitle: string;
  testCaseSequenceNumber: number;
  testCaseLevelCode: string;
  customFieldValues: CustomFieldValueView[];
  lastExecution: LastExecution | null;
}

const ALL_TIME = "all_time";

function roundOptionLabel(round: {
  label: string | null;
  startedAt: string | Date;
  itemCount: number;
  passCount: number;
}): string {
  const date = new Date(round.startedAt).toLocaleDateString();
  return `${round.label ?? `Round · ${date}`} — ${round.passCount}/${round.itemCount} passed`;
}

function testCaseLabel(option: TestCaseOption): string {
  return `${formatItemId(option.levelCode, option.sequenceNumber)}: ${option.title}`;
}

export default function TestSetDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const utils = trpc.useUtils();
  const detail = trpc.testSets.get.useQuery({ id });
  const productId = detail.data?.set.productId ?? "";

  const testCaseOptions = trpc.testCases.listAllByProduct.useQuery({ productId }, { enabled: !!detail.data });
  const customFieldsQuery = trpc.settings.listCustomFields.useQuery({ entityType: "test_run" });
  const customFieldDefs = asCustomFieldDefinitions(customFieldsQuery.data ?? []);

  // Rounds are optional - "all_time" (the set's whole history, today's original behavior)
  // until one is started, then the most recently started round by default. Once rounds
  // exist, switching the Select never gets overridden again (the ref only fires once).
  const roundsQuery = trpc.testSets.listRounds.useQuery({ testSetId: id });
  const [selectedRoundId, setSelectedRoundId] = useState<string>(ALL_TIME);
  const hasDefaultedRoundRef = useRef(false);
  useEffect(() => {
    if (hasDefaultedRoundRef.current || !roundsQuery.data) return;
    hasDefaultedRoundRef.current = true;
    if (roundsQuery.data.length > 0) setSelectedRoundId(roundsQuery.data[0]!.id);
  }, [roundsQuery.data]);
  const usingRound = selectedRoundId !== ALL_TIME;
  const roundDetail = trpc.testSets.getRound.useQuery({ id: selectedRoundId }, { enabled: usingRound });

  const [showNewRoundForm, setShowNewRoundForm] = useState(false);
  const [newRoundLabel, setNewRoundLabel] = useState("");
  const startRound = trpc.testSets.startRound.useMutation({
    onSuccess: (round) => {
      utils.testSets.listRounds.invalidate({ testSetId: id });
      setSelectedRoundId(round.id);
      setNewRoundLabel("");
      setShowNewRoundForm(false);
    },
  });

  // Structural item edits (add/remove/reorder/parameters) are visible from both the
  // all-time view and whichever round is currently selected - invalidate both so neither
  // goes stale depending on which one happens to be on screen.
  const invalidate = () => {
    utils.testSets.get.invalidate({ id });
    if (usingRound) utils.testSets.getRound.invalidate({ id: selectedRoundId });
  };

  const updateTestSet = trpc.testSets.update.useMutation({ onSuccess: () => utils.testSets.get.invalidate({ id }) });
  const deleteTestSet = trpc.testSets.delete.useMutation();
  const addItem = trpc.testSets.addItem.useMutation({ onSuccess: invalidate });
  const updateItem = trpc.testSets.updateItem.useMutation({ onSuccess: invalidate });
  const removeItem = trpc.testSets.removeItem.useMutation({ onSuccess: invalidate });
  const reorderItem = trpc.testSets.reorderItem.useMutation({ onSuccess: invalidate });

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const hasInitializedRef = useRef(false);
  useEffect(() => {
    if (hasInitializedRef.current || !detail.data) return;
    hasInitializedRef.current = true;
    setName(detail.data.set.name);
    setDescription(detail.data.set.description ?? "");
  }, [detail.data]);

  const [newTestCaseId, setNewTestCaseId] = useState<string | null>(null);
  const [newCustomFieldState, setNewCustomFieldState] = useState<CustomFieldFormState>({});

  const testCaseItems = useMemo(
    () =>
      testCaseOptions.data
        ? ComboboxPrimitive.createItems(testCaseOptions.data, {
            getValue: (option: TestCaseOption) => option.id,
            getLabel: testCaseLabel,
          })
        : [],
    [testCaseOptions.data],
  );

  if (detail.isLoading) return <p className="p-10 text-[13.5px] text-muted-foreground">Loading...</p>;
  if (detail.error || !detail.data) {
    return <p className="p-10 text-sm text-destructive">{detail.error?.message}</p>;
  }

  const { set, items: allTimeItems } = detail.data as { set: typeof detail.data.set; items: TestSetItem[] };
  const items = usingRound ? ((roundDetail.data?.items as TestSetItem[] | undefined) ?? []) : allTimeItems;
  const itemsLoading = usingRound && roundDetail.isLoading;
  const isDirty = name !== set.name || description !== (set.description ?? "");

  return (
    <>
      <ProductContextStrip productId={set.productId} entry="testSets" activeLevelId={null} />

      <div className="flex items-center justify-between border-b border-border bg-card px-5 py-[9px]">
        <span className="font-mono text-xs text-muted-foreground">
          <Link href={entryHref(set.productId, "testSets")} className="hover:text-foreground">
            Test sets
          </Link>{" "}
          <span className="opacity-50">/</span> <span className="font-medium text-foreground">{set.name}</span>
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={deleteTestSet.isPending}
          onClick={() => {
            if (!confirm(`Delete test set "${set.name}"? This cannot be undone.`)) return;
            deleteTestSet.mutate({ id }, { onSuccess: () => router.push(entryHref(set.productId, "testSets")) });
          }}
        >
          {deleteTestSet.isPending ? "Deleting..." : "Delete"}
        </Button>
      </div>

      <div className="p-6">
        <form
          className="max-w-3xl space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            updateTestSet.mutate({ id, name, description: description || undefined });
          }}
        >
          <Input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-auto border-0 bg-transparent p-0 font-heading text-[28px] leading-tight tracking-tight focus-visible:ring-0"
          />
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="Description"
          />
          {updateTestSet.error && <p className="text-sm text-destructive">{updateTestSet.error.message}</p>}
          {isDirty && (
            <Button type="submit" size="sm" disabled={updateTestSet.isPending || !name.trim()}>
              {updateTestSet.isPending ? "Saving…" : "Save changes"}
            </Button>
          )}
        </form>

        <div className="mt-4.5 flex max-w-3xl flex-wrap items-center gap-2.5">
          <span className="text-xs font-medium text-muted-foreground">Round</span>
          <Select value={selectedRoundId} onValueChange={(v) => setSelectedRoundId(v ?? ALL_TIME)}>
            <SelectTrigger className="h-8 w-auto min-w-[220px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_TIME}>All-time</SelectItem>
              {roundsQuery.data?.map((round) => (
                <SelectItem key={round.id} value={round.id}>
                  {roundOptionLabel(round)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {showNewRoundForm ? (
            <form
              className="flex items-center gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                startRound.mutate({ testSetId: id, label: newRoundLabel || undefined });
              }}
            >
              <Input
                autoFocus
                value={newRoundLabel}
                onChange={(e) => setNewRoundLabel(e.target.value)}
                placeholder="e.g. Release 1.2 (optional)"
                className="h-8 w-56"
              />
              <Button type="submit" size="sm" disabled={startRound.isPending}>
                {startRound.isPending ? "Starting…" : "Start"}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => setShowNewRoundForm(false)}>
                Cancel
              </Button>
            </form>
          ) : (
            <Button type="button" variant="outline" size="sm" onClick={() => setShowNewRoundForm(true)}>
              Start new round
            </Button>
          )}
        </div>
        {startRound.error && <p className="mt-1 max-w-3xl text-sm text-destructive">{startRound.error.message}</p>}

        {!itemsLoading && <RunOverview items={items} />}

        <div className="mt-6">
          <h3 className="mb-2 font-heading text-[13px] tracking-[0.14em] text-muted-foreground uppercase">
            Tests ({items.length})
          </h3>
          {itemsLoading ? (
            <p className="text-[13.5px] text-muted-foreground">Loading round…</p>
          ) : items.length === 0 ? (
            <p className="text-[13.5px] text-muted-foreground">No tests added yet.</p>
          ) : (
            <Frame className="bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[36px]" />
                    <TableHead>Test case</TableHead>
                    {customFieldDefs.length > 0 && <TableHead className="w-[180px]">Parameters</TableHead>}
                    <TableHead className="w-[190px]">Last run</TableHead>
                    <TableHead className="w-[220px]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((item, i) => (
                    <TestSetItemRow
                      key={item.id}
                      item={item}
                      index={i}
                      itemCount={items.length}
                      testSetId={id}
                      testSetRoundId={usingRound ? selectedRoundId : undefined}
                      customFieldDefs={customFieldDefs}
                      updateItem={updateItem}
                      removeItem={removeItem}
                      reorderItem={reorderItem}
                    />
                  ))}
                </TableBody>
              </Table>
            </Frame>
          )}
        </div>

        <form
          className="mt-6 max-w-3xl space-y-3 border border-border bg-card p-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!newTestCaseId) return;
            addItem.mutate(
              {
                testSetId: id,
                testCaseId: newTestCaseId,
                customFieldValues: toCustomFieldValuesInput(newCustomFieldState),
              },
              {
                onSuccess: () => {
                  setNewTestCaseId(null);
                  setNewCustomFieldState(emptyCustomFieldFormState(customFieldDefs));
                },
              },
            );
          }}
        >
          <h3 className="font-heading text-[13px] tracking-[0.14em] text-muted-foreground uppercase">Add test case</h3>

          <Label className="flex-col items-start gap-1">
            <span className="text-xs font-medium text-muted-foreground">Test case</span>
            <Combobox
              items={testCaseItems}
              value={newTestCaseId}
              onValueChange={(value) => setNewTestCaseId(value)}
            >
              <ComboboxInputGroup className="w-full">
                <ComboboxInput placeholder="Search test cases…" />
              </ComboboxInputGroup>
              <ComboboxPortal>
                <ComboboxPositioner>
                  <ComboboxPopup>
                    <ComboboxEmpty>
                      {testCaseOptions.data?.length === 0 ? "No test cases in this product yet." : "No matching test cases."}
                    </ComboboxEmpty>
                    <ComboboxList>
                      {(option: TestCaseOption) => (
                        <ComboboxItem key={option.id} value={option.id}>
                          {testCaseLabel(option)}
                        </ComboboxItem>
                      )}
                    </ComboboxList>
                  </ComboboxPopup>
                </ComboboxPositioner>
              </ComboboxPortal>
            </Combobox>
          </Label>

          <CustomFieldInputs
            fields={customFieldDefs}
            state={newCustomFieldState}
            onChange={(fieldId, value) => setNewCustomFieldState((s) => ({ ...s, [fieldId]: value }))}
          />

          {addItem.error && <p className="text-sm text-destructive">{addItem.error.message}</p>}
          <Button type="submit" disabled={addItem.isPending || !newTestCaseId}>
            {addItem.isPending ? "Adding…" : "Add to test set"}
          </Button>
        </form>
      </div>
    </>
  );
}

/** Summary strip above the table: pass/fail/blocked/abandoned/not-run/in-progress counts
 * (derived from each item's `lastExecution`, no extra query) plus a "currently running"
 * roster - literally "what's being run at the moment", i.e. started but not yet
 * completed. Renders nothing for an empty set - there's nothing to summarize yet. */
function RunOverview({ items }: { items: TestSetItem[] }) {
  if (items.length === 0) return null;

  const counts: Record<string, number> = { not_run: 0, in_progress: 0, pass: 0, fail: 0, blocked: 0, abandoned: 0 };
  for (const item of items) {
    const status = item.lastExecution?.status ?? "not_run";
    counts[status] = (counts[status] ?? 0) + 1;
  }
  const running = items.filter((item) => item.lastExecution && !item.lastExecution.completedAt);

  return (
    <div className="mt-4.5 max-w-3xl space-y-3 border border-border bg-card p-3.5">
      <div className="flex flex-wrap items-center gap-4">
        {STATUS_ORDER.map((status) => (
          <div key={status} className="flex items-center gap-1.5">
            <ResultBadge status={status} />
            <span className="font-mono text-[13px] text-foreground">{counts[status] ?? 0}</span>
          </div>
        ))}
      </div>

      {running.length > 0 && (
        <div className="space-y-1 border-t border-border pt-2.5">
          <p className="text-[11.5px] font-medium tracking-[0.08em] text-muted-foreground uppercase">Currently running</p>
          <ul className="space-y-1">
            {running.map((item) => (
              <li key={item.id} className="flex items-center justify-between gap-2 text-[13px]">
                <span className="min-w-0 truncate">
                  {formatItemId(item.testCaseLevelCode, item.testCaseSequenceNumber)}: {item.testCaseTitle}
                  <span className="text-muted-foreground"> — {item.lastExecution!.executedByName}, started {new Date(item.lastExecution!.startedAt).toLocaleString()}</span>
                </span>
                <Link
                  href={`/test-cases/${item.testCaseId}/executions/${item.lastExecution!.id}`}
                  className="shrink-0 font-medium text-primary hover:underline"
                >
                  Continue run →
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function TestSetItemRow({
  item,
  index,
  itemCount,
  testSetId,
  testSetRoundId,
  customFieldDefs,
  updateItem,
  removeItem,
  reorderItem,
}: {
  item: TestSetItem;
  index: number;
  itemCount: number;
  testSetId: string;
  /** The currently selected round, if any - tags the execution so its progress shows up
   * under that round instead of (or in addition to) the set's all-time history. */
  testSetRoundId?: string;
  customFieldDefs: ReturnType<typeof asCustomFieldDefinitions>;
  updateItem: ReturnType<typeof trpc.testSets.updateItem.useMutation>;
  removeItem: ReturnType<typeof trpc.testSets.removeItem.useMutation>;
  reorderItem: ReturnType<typeof trpc.testSets.reorderItem.useMutation>;
}) {
  const router = useRouter();
  const startExecution = trpc.testCases.startExecution.useMutation();

  const isOpenRun = !!item.lastExecution && !item.lastExecution.completedAt;
  const paramsSummary =
    item.customFieldValues
      .filter((v) => v.value != null)
      .map((v) => `${v.name}: ${formatCustomFieldValue(v)}`)
      .join(", ") || "—";
  // Same required-field gate startExecution's own setCustomFieldValues enforces server
  // side - checked here too so "Run" can just be disabled instead of round-tripping an
  // error. getCustomFieldValuesForEntities always returns one row per defined field
  // (value: null if unset), so this doesn't need customFieldDefs at all.
  const canRun = item.customFieldValues.every((v) => !v.isRequired || v.value != null);

  return (
    <TableRow>
      <TableCell className="align-top">
        <div className="flex flex-col">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            disabled={index === 0 || reorderItem.isPending}
            onClick={() => reorderItem.mutate({ testSetId, itemId: item.id, direction: "up" })}
            aria-label="Move up"
          >
            <ChevronUp />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            disabled={index === itemCount - 1 || reorderItem.isPending}
            onClick={() => reorderItem.mutate({ testSetId, itemId: item.id, direction: "down" })}
            aria-label="Move down"
          >
            <ChevronDown />
          </Button>
        </div>
      </TableCell>

      <TableCell className="align-top">
        <Link href={`/test-cases/${item.testCaseId}`} className="text-[13.5px] font-medium hover:underline">
          {formatItemId(item.testCaseLevelCode, item.testCaseSequenceNumber)}: {item.testCaseTitle}
        </Link>
      </TableCell>

      {customFieldDefs.length > 0 && (
        <TableCell className="align-top">
          <Popover>
            <PopoverTrigger
              className="max-w-[150px] truncate text-left text-[13px] text-muted-foreground hover:text-foreground"
              title={paramsSummary}
            >
              {paramsSummary}
            </PopoverTrigger>
            <PopoverContent align="start">
              <ItemCustomFieldsEditor
                fields={customFieldDefs}
                values={item.customFieldValues}
                onSave={(state) => updateItem.mutate({ itemId: item.id, customFieldValues: toCustomFieldValuesInput(state) })}
                isPending={updateItem.isPending}
              />
            </PopoverContent>
          </Popover>
        </TableCell>
      )}

      <TableCell className="align-top">
        {item.lastExecution ? (
          <Link href={`/test-cases/${item.testCaseId}/executions/${item.lastExecution.id}`} className="block space-y-0.5">
            <ResultBadge status={item.lastExecution.status} />
            <p className="text-[11.5px] text-muted-foreground">
              {new Date(item.lastExecution.startedAt).toLocaleDateString()} · {item.lastExecution.executedByName}
            </p>
          </Link>
        ) : (
          <span className="text-[13px] text-muted-foreground">Never run</span>
        )}
      </TableCell>

      <TableCell className="align-top">
        <div className="flex items-center gap-2">
          {isOpenRun ? (
            <Link
              href={`/test-cases/${item.testCaseId}/executions/${item.lastExecution!.id}`}
              className="text-[13px] font-medium text-primary hover:underline"
            >
              Continue run →
            </Link>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!canRun || startExecution.isPending}
              title={canRun ? undefined : "Fill in this item's required run parameters first"}
              onClick={() => {
                if (!canRun) return;
                startExecution.mutate(
                  {
                    testCaseId: item.testCaseId,
                    testSetItemId: item.id,
                    testSetRoundId,
                    // Carries the item's own already-set parameters onto the execution -
                    // see test-cases.ts's startExecution and test-sets.ts's docstring.
                    customFieldValues: item.customFieldValues.map((v) => ({ fieldId: v.fieldId, value: v.value })),
                  },
                  { onSuccess: (result) => router.push(`/test-cases/${item.testCaseId}/executions/${result.execution.id}`) },
                );
              }}
            >
              {startExecution.isPending ? "Starting…" : "Run"}
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={removeItem.isPending}
            onClick={() => removeItem.mutate({ itemId: item.id })}
          >
            Remove
          </Button>
        </div>
        {startExecution.error && <p className="mt-1 text-xs text-destructive">{startExecution.error.message}</p>}
      </TableCell>
    </TableRow>
  );
}

/** Inline editor for one item's test_run custom field values (Environment and anything
 * else a tenant has defined) - seeded from the item's current values, saved on demand
 * rather than on every keystroke, since a "save immediately" feel would be too noisy for
 * text fields. */
function ItemCustomFieldsEditor({
  fields,
  values,
  onSave,
  isPending,
}: {
  fields: ReturnType<typeof asCustomFieldDefinitions>;
  values: CustomFieldValueView[];
  onSave: (state: CustomFieldFormState) => void;
  isPending: boolean;
}) {
  const [state, setState] = useState<CustomFieldFormState>(() => {
    const initial: CustomFieldFormState = {};
    for (const f of fields) {
      const existing = values.find((v) => v.fieldId === f.id);
      initial[f.id] = f.fieldType === "boolean" ? existing?.value === "true" : (existing?.value ?? "");
    }
    return initial;
  });

  return (
    <div className="space-y-3">
      <CustomFieldInputs fields={fields} state={state} onChange={(fieldId, value) => setState((s) => ({ ...s, [fieldId]: value }))} />
      <Button type="button" size="sm" variant="outline" disabled={isPending} onClick={() => onSave(state)}>
        {isPending ? "Saving…" : "Save parameters"}
      </Button>
    </div>
  );
}
