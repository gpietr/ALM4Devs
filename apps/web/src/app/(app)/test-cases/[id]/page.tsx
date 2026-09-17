"use client";

import { ProductContextStrip } from "@/components/context-strip";
import {
  asCustomFieldDefinitions,
  customFieldFormStateFromValues,
  type CustomFieldFormState,
  type CustomFieldValueView,
  CustomFieldInputs,
  toCustomFieldValuesInput,
} from "@/components/custom-fields";
import { BulkGenerateDocumentButton } from "@/components/bulk-generate-document-button";
import { GenerateDocumentButton } from "@/components/generate-document-button";
import { ContextRail } from "@/components/context-rail";
import { RequirementPicker } from "@/components/requirement-picker";
import { emptyStep, type StepDraft, TestStepsEditor } from "@/components/test-steps-editor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatItemId } from "@/lib/format-item-id";
import { trpc } from "@/lib/trpc-client";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useEffect, useRef, useState } from "react";

/** A comparable snapshot of everything the form can change, for the dirty check the Save/
 * Discard buttons and the unsaved-changes guard both key off - `key` is deliberately left
 * out since it's a client-only React key (stable per step, not part of what gets saved).
 * `requirementIds` order matters here even though it may not to the server (order changes
 * alone would show as "dirty"), a reasonable tradeoff against the complexity of an
 * order-independent comparison for something that in practice never happens on its own.
 * Custom field values are part of this same form/Save now (see updateTestCase.mutate
 * below), so they're part of the same dirty check too - a test case has no versioning
 * concept to keep them separate from, unlike a requirement's. */
function snapshotOf(title: string, requirementIds: string[], steps: StepDraft[], customFieldState: CustomFieldFormState): string {
  return JSON.stringify({
    title,
    requirementIds,
    steps: steps.map((s) => ({
      id: s.id ?? null,
      description: s.description,
      expectedResult: s.expectedResult,
      purpose: s.purpose,
      requirementIds: s.requirementIds,
    })),
    customFieldState,
  });
}

export default function TestCaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const utils = trpc.useUtils();
  const detail = trpc.testCases.get.useQuery({ id });
  const levels = trpc.testCases.listLevels.useQuery();
  const requirementOptions = trpc.requirements.listAllByProduct.useQuery(
    { productId: detail.data?.testCase.productId ?? "" },
    { enabled: !!detail.data },
  );
  const customFieldsQuery = trpc.settings.listCustomFields.useQuery({ entityType: "test_case" });
  const customFieldDefs = asCustomFieldDefinitions(customFieldsQuery.data ?? []);
  const updateTestCase = trpc.testCases.update.useMutation({
    // Rebuilt from the mutation's own response + the variables just submitted, not a
    // refetch round-trip: `result.steps` comes back in the same order as `variables.steps`
    // was submitted (packages/core's updateTestCase processes them in array order), so
    // pairing them by index recovers each step's requirementIds - the response itself
    // doesn't echo links back, and a brand-new step's id isn't known until this response
    // arrives anyway. Custom field values aren't echoed back either (setCustomFieldValues
    // returns no rows) - rebuilt from `variables.customFieldValues` (what was actually
    // submitted) rather than the live `customFieldState` closure, for the same reason
    // title/steps aren't: the user could still be typing when this resolves.
    onSuccess: (result, variables) => {
      utils.testCases.get.invalidate({ id });
      const newTitle = result.testCase.title;
      const newRequirementIds = variables.requirementIds ?? [];
      const newSteps = result.steps.map((s, i) => ({
        id: s.id,
        key: s.id,
        description: s.description,
        expectedResult: s.expectedResult,
        purpose: s.purpose ?? "",
        requirementIds: variables.steps[i]?.requirementIds ?? [],
      }));
      const newCustomFieldState: CustomFieldFormState = Object.fromEntries(
        (variables.customFieldValues ?? []).map((v) => [
          v.fieldId,
          // Reconstructing CustomFieldFormState's shape from what was actually submitted
          // - a boolean stays a boolean (matches Switch's own value type), everything
          // else (including a number, for an integer field) becomes its string form,
          // same as CustomFieldInput's own text/number inputs already work with.
          typeof v.value === "boolean" ? v.value : (v.value?.toString() ?? ""),
        ]),
      );
      setTitle(newTitle);
      setRequirementIds(newRequirementIds);
      setSteps(newSteps);
      setCustomFieldState(newCustomFieldState);
      setSavedSnapshot(snapshotOf(newTitle, newRequirementIds, newSteps, newCustomFieldState));
    },
  });
  const deleteTestCase = trpc.testCases.delete.useMutation();

  const [title, setTitle] = useState("");
  const [requirementIds, setRequirementIds] = useState<string[]>([]);
  const [steps, setSteps] = useState<StepDraft[]>([emptyStep()]);
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(null);
  const [customFieldState, setCustomFieldState] = useState<CustomFieldFormState>({});

  // Test cases have no locked/approval state at all (unlike requirements) - so unlike that
  // page, there's no "only auto-open if unlocked" condition here: this form is simply
  // always the page, not a read-only view you have to click into an edit mode from. Still
  // guarded by a ref so it initializes local state exactly once per visit rather than every
  // time the query refetches (which happens right after a save) and clobbering fields the
  // user may already be mid-edit on.
  const hasInitializedRef = useRef(false);
  function syncFromServer(
    tc: { title: string },
    srvSteps: Array<{
      id: string;
      description: string;
      expectedResult: string;
      purpose: string | null;
      requirementLinks: { id: string }[];
    }>,
    directIds: string[],
    customFieldValues: CustomFieldValueView[],
  ) {
    const newSteps = srvSteps.map((s) => ({
      id: s.id,
      key: s.id,
      description: s.description,
      expectedResult: s.expectedResult,
      purpose: s.purpose ?? "",
      requirementIds: s.requirementLinks.map((r) => r.id),
    }));
    const newCustomFieldState = customFieldFormStateFromValues(customFieldValues);
    setTitle(tc.title);
    setRequirementIds(directIds);
    setSteps(newSteps);
    setCustomFieldState(newCustomFieldState);
    setSavedSnapshot(snapshotOf(tc.title, directIds, newSteps, newCustomFieldState));
  }
  useEffect(() => {
    if (hasInitializedRef.current || !detail.data) return;
    hasInitializedRef.current = true;
    syncFromServer(detail.data.testCase, detail.data.steps, detail.data.directRequirementIds, detail.data.customFieldValues);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.data]);

  // `savedSnapshot` is null until the first sync, so this stays false rather than flashing
  // "dirty" against the empty initial state on every load. Computed above the loading/error
  // returns below since hooks (including the guard it feeds) must run unconditionally.
  const isDirty = savedSnapshot !== null && snapshotOf(title, requirementIds, steps, customFieldState) !== savedSnapshot;
  useUnsavedChangesGuard(isDirty, "You have unsaved changes on this test case. Leave without saving?");

  function save() {
    updateTestCase.mutate({
      testCaseId: id,
      title,
      requirementIds: requirementIds.length ? requirementIds : undefined,
      steps: steps.map((s) => ({
        id: s.id,
        description: s.description,
        expectedResult: s.expectedResult,
        purpose: s.purpose || undefined,
        requirementIds: s.requirementIds.length ? s.requirementIds : undefined,
      })),
      customFieldValues: toCustomFieldValuesInput(customFieldState),
    });
  }

  // A real ⌘S handler, not just a label claiming one exists - see context-rail.tsx's
  // identical note on the step recorder's ⌘↵.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (isDirty && !updateTestCase.isPending) save();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDirty, updateTestCase.isPending, title, requirementIds, steps, customFieldState]);

  if (detail.isLoading) return <p className="p-10 text-[13.5px] text-muted-foreground">Loading...</p>;
  if (detail.error || !detail.data) {
    return <p className="p-10 text-sm text-destructive">{detail.error?.message}</p>;
  }

  const { testCase, effectiveRequirementLinks, executions } = detail.data;
  const levelName = levels.data?.find((l) => l.id === testCase.levelId)?.name ?? "Test Cases";
  const displayId = formatItemId(testCase.levelCode, testCase.sequenceNumber);

  function discardChanges() {
    syncFromServer(testCase, detail.data!.steps, detail.data!.directRequirementIds, detail.data!.customFieldValues);
  }

  return (
    <>
      <ProductContextStrip productId={testCase.productId} artifact="testCases" activeLevelId={testCase.levelId} />

      {/* Sub-header: breadcrumb left, document/delete actions right - same grammar as
          the "2d" reference's own sub-header row. */}
      <div className="flex items-center justify-between border-b border-border bg-card px-5 py-[9px]">
        <span className="font-mono text-xs text-muted-foreground">
          <Link href={`/products/${testCase.productId}?artifact=testCases&level=${testCase.levelId}`} className="hover:text-foreground">
            {testCase.levelCode}
          </Link>{" "}
          <span className="opacity-50">/</span> <span className="font-medium text-foreground">{displayId}</span>
        </span>
        <div className="flex items-center gap-2.5">
          <GenerateDocumentButton scope="test_case" buildRequestBody={() => ({ testCaseId: id })} />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={deleteTestCase.isPending}
            onClick={() => {
              if (!confirm(`Delete ${displayId} "${testCase.title}"? This cannot be undone.`)) return;
              deleteTestCase.mutate(
                { id },
                { onSuccess: () => router.push(`/products/${testCase.productId}?artifact=testCases&level=${testCase.levelId}`) },
              );
            }}
          >
            {deleteTestCase.isPending ? "Deleting..." : "Delete"}
          </Button>
        </div>
      </div>
      {deleteTestCase.error && <p className="px-5 pt-2 text-sm text-destructive">{deleteTestCase.error.message}</p>}

      <div className="flex items-stretch">
        {/* Left column: title, custom fields, links, steps, save bar. */}
        <form
          className="min-w-0 flex-1 space-y-5 p-5 pb-8"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <div className="flex items-start gap-3.5 border-b border-border pb-3.5">
            <span className="mt-1.5 bg-foreground px-1.5 py-0.5 font-mono text-[13px] font-medium text-background">{displayId}</span>
            <div className="min-w-0 flex-1">
              <Input
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="h-auto border-0 bg-transparent p-0 font-heading text-[28px] leading-tight tracking-tight focus-visible:ring-0"
              />
              {effectiveRequirementLinks.length > 0 && (
                <p className="mt-1 text-[13.5px] text-muted-foreground">
                  Covers{" "}
                  {effectiveRequirementLinks.map((r, i) => (
                    <span key={r.id}>
                      {i > 0 && ", "}
                      <Link href={`/requirements/${r.id}`} className="font-mono text-[12.5px] text-foreground hover:text-primary">
                        {formatItemId(r.levelCode, r.sequenceNumber)}
                      </Link>
                    </span>
                  ))}{" "}
                  · {steps.length} step{steps.length === 1 ? "" : "s"}
                </p>
              )}
            </div>
          </div>

          <CustomFieldInputs
            fields={customFieldDefs}
            state={customFieldState}
            onChange={(fieldId, value) => setCustomFieldState((s) => ({ ...s, [fieldId]: value }))}
          />

          <Label className="flex-col items-start gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              Linked requirements (applies to the whole test case, independent of any step link)
            </span>
            <RequirementPicker options={requirementOptions.data ?? []} value={requirementIds} onChange={setRequirementIds} />
          </Label>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <h5 className="font-heading text-[13px] tracking-[0.14em] text-muted-foreground uppercase">Steps</h5>
            </div>
            <TestStepsEditor steps={steps} onChange={setSteps} requirementOptions={requirementOptions.data ?? []} />
          </div>

          {updateTestCase.error && <p className="text-sm text-destructive">{updateTestCase.error.message}</p>}

          {/* Not fixed to the viewport any more - a 1px top rule at the end of the
              form, per the handoff. */}
          <div className="flex items-center gap-2.5 border-t border-border pt-3">
            <Button type="submit" disabled={updateTestCase.isPending || !isDirty}>
              {updateTestCase.isPending ? "Saving…" : "Save changes"}
              <span className="ml-1.5 border border-primary-foreground/45 px-1 font-mono text-[10px] font-normal normal-case">⌘S</span>
            </Button>
            <Button type="button" variant="outline" onClick={discardChanges} disabled={updateTestCase.isPending || !isDirty}>
              Discard
            </Button>
            {isDirty && <span className="ml-auto text-[13px] text-muted-foreground">Unsaved edits</span>}
          </div>
        </form>

        <ContextRail
          testCaseId={id}
          productId={testCase.productId}
          testCaseTitle={title}
          testCaseDisplayId={displayId}
          steps={steps}
          onAcceptAiSteps={setSteps}
          requirementOptions={requirementOptions.data ?? []}
          executions={executions}
          isDirty={isDirty}
        />
      </div>

      {executions.length > 0 && (
        <div className="border-t border-border px-5 py-3">
          <BulkSection testCaseId={id} executions={executions} />
        </div>
      )}
    </>
  );
}

/** Bulk-select a few of this test case's own executions to zip up as separate reports
 * (backlog item 9.32) - kept as its own small piece below the two-column layout, since
 * the rail's own History tab is a compact roster, not the right place for a multi-select
 * bulk action. */
function BulkSection({ testCaseId, executions }: { testCaseId: string; executions: Array<{ id: string; startedAt: string | Date }> }) {
  const [selectedExecutionIds, setSelectedExecutionIds] = useState<Set<string>>(new Set());
  if (executions.length === 0) return null;
  return (
    <div className="flex items-center gap-3">
      <p className="text-[13px] text-muted-foreground">Select executions to bundle into one report:</p>
      <div className="flex flex-wrap gap-1.5">
        {executions.map((ex) => (
          <label key={ex.id} className="flex cursor-pointer items-center gap-1.5 border border-border px-2 py-1 text-xs">
            <input
              type="checkbox"
              className="accent-primary"
              checked={selectedExecutionIds.has(ex.id)}
              onChange={() =>
                setSelectedExecutionIds((prev) => {
                  const next = new Set(prev);
                  if (next.has(ex.id)) next.delete(ex.id);
                  else next.add(ex.id);
                  return next;
                })
              }
            />
            {new Date(ex.startedAt).toLocaleDateString()}
          </label>
        ))}
      </div>
      {selectedExecutionIds.size > 0 && (
        <BulkGenerateDocumentButton
          scope="test_execution"
          ids={[...selectedExecutionIds]}
          onDone={() => setSelectedExecutionIds(new Set())}
        />
      )}
    </div>
  );
}
