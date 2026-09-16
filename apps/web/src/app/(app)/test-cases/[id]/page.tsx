"use client";

import { ProductContextStrip } from "@/components/context-strip";
import {
  asCustomFieldDefinitions,
  customFieldFormStateFromValues,
  type CustomFieldFormState,
  CustomFieldInputs,
  formatCustomFieldValue,
  toCustomFieldValuesInput,
} from "@/components/custom-fields";
import { BulkGenerateDocumentButton } from "@/components/bulk-generate-document-button";
import { GenerateDocumentButton } from "@/components/generate-document-button";
import { RequirementPicker } from "@/components/requirement-picker";
import { ResultBadge } from "@/components/result-badge";
import { emptyStep, type StepDraft, TestStepsEditor } from "@/components/test-steps-editor";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
 * order-independent comparison for something that in practice never happens on its own. */
function snapshotOf(title: string, testType: string, requirementIds: string[], steps: StepDraft[]): string {
  return JSON.stringify({
    title,
    testType,
    requirementIds,
    steps: steps.map((s) => ({
      id: s.id ?? null,
      description: s.description,
      expectedResult: s.expectedResult,
      purpose: s.purpose,
      requirementIds: s.requirementIds,
    })),
  });
}

export default function TestCaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const utils = trpc.useUtils();
  const detail = trpc.testCases.get.useQuery({ id });
  const environments = trpc.testCases.listEnvironments.useQuery();
  const levels = trpc.testCases.listLevels.useQuery();
  const requirementOptions = trpc.requirements.listAllByProduct.useQuery(
    { productId: detail.data?.testCase.productId ?? "" },
    { enabled: !!detail.data },
  );
  const customFieldsQuery = trpc.settings.listCustomFields.useQuery({ entityType: "test_case" });
  const customFieldDefs = asCustomFieldDefinitions(customFieldsQuery.data ?? []);
  const startExecution = trpc.testCases.startExecution.useMutation({
    onSuccess: (result) => router.push(`/test-cases/${id}/executions/${result.execution.id}`),
  });
  const updateCustomFieldValues = trpc.testCases.updateCustomFieldValues.useMutation({
    onSuccess: () => utils.testCases.get.invalidate({ id }),
  });
  const updateTestCase = trpc.testCases.update.useMutation({
    // Rebuilt from the mutation's own response + the variables just submitted, not a
    // refetch round-trip: `result.steps` comes back in the same order as `variables.steps`
    // was submitted (packages/core's updateTestCase processes them in array order), so
    // pairing them by index recovers each step's requirementIds - the response itself
    // doesn't echo links back, and a brand-new step's id isn't known until this response
    // arrives anyway.
    onSuccess: (result, variables) => {
      utils.testCases.get.invalidate({ id });
      const newTitle = result.testCase.title;
      const newTestType = result.testCase.testType as "verification" | "validation";
      const newRequirementIds = variables.requirementIds ?? [];
      const newSteps = result.steps.map((s, i) => ({
        id: s.id,
        key: s.id,
        description: s.description,
        expectedResult: s.expectedResult,
        purpose: s.purpose ?? "",
        requirementIds: variables.steps[i]?.requirementIds ?? [],
      }));
      setTitle(newTitle);
      setTestType(newTestType);
      setRequirementIds(newRequirementIds);
      setSteps(newSteps);
      setSavedSnapshot(snapshotOf(newTitle, newTestType, newRequirementIds, newSteps));
    },
  });
  const deleteTestCase = trpc.testCases.delete.useMutation();

  const [environmentId, setEnvironmentId] = useState("");
  const [title, setTitle] = useState("");
  const [testType, setTestType] = useState<"verification" | "validation">("verification");
  const [requirementIds, setRequirementIds] = useState<string[]>([]);
  const [steps, setSteps] = useState<StepDraft[]>([emptyStep()]);
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(null);
  const [editingCustomFields, setEditingCustomFields] = useState(false);
  const [customFieldState, setCustomFieldState] = useState<CustomFieldFormState>({});
  // Bulk-select a few of this test case's own executions to zip up as separate reports
  // (backlog item 9.32) - declared here, unconditionally, not below the loading guard,
  // since hooks can't follow an early return.
  const [selectedExecutionIds, setSelectedExecutionIds] = useState<Set<string>>(new Set());

  // Test cases have no locked/approval state at all (unlike requirements) - so unlike that
  // page, there's no "only auto-open if unlocked" condition here: this form is simply
  // always the page, not a read-only view you have to click into an edit mode from. Still
  // guarded by a ref so it initializes local state exactly once per visit rather than every
  // time the query refetches (which happens right after a save) and clobbering fields the
  // user may already be mid-edit on.
  const hasInitializedRef = useRef(false);
  function syncFromServer(
    tc: { title: string; testType: string },
    srvSteps: Array<{
      id: string;
      description: string;
      expectedResult: string;
      purpose: string | null;
      requirementLinks: { id: string }[];
    }>,
    directIds: string[],
  ) {
    const newTestType = tc.testType as "verification" | "validation";
    const newSteps = srvSteps.map((s) => ({
      id: s.id,
      key: s.id,
      description: s.description,
      expectedResult: s.expectedResult,
      purpose: s.purpose ?? "",
      requirementIds: s.requirementLinks.map((r) => r.id),
    }));
    setTitle(tc.title);
    setTestType(newTestType);
    setRequirementIds(directIds);
    setSteps(newSteps);
    setSavedSnapshot(snapshotOf(tc.title, newTestType, directIds, newSteps));
  }
  useEffect(() => {
    if (hasInitializedRef.current || !detail.data) return;
    hasInitializedRef.current = true;
    syncFromServer(detail.data.testCase, detail.data.steps, detail.data.directRequirementIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.data]);

  // `savedSnapshot` is null until the first sync, so this stays false rather than flashing
  // "dirty" against the empty initial state on every load. Computed above the loading/error
  // returns below since hooks (including the guard it feeds) must run unconditionally.
  const isDirty = savedSnapshot !== null && snapshotOf(title, testType, requirementIds, steps) !== savedSnapshot;
  useUnsavedChangesGuard(isDirty, "You have unsaved changes on this test case. Leave without saving?");

  if (detail.isLoading) return <main className="mx-auto max-w-3xl px-4 py-16 text-sm text-muted-foreground">Loading...</main>;
  if (detail.error || !detail.data) {
    return <main className="mx-auto max-w-3xl px-4 py-16 text-sm text-destructive">{detail.error?.message}</main>;
  }

  const { testCase, effectiveRequirementLinks, executions, customFieldValues } = detail.data;
  const levelName = levels.data?.find((l) => l.id === testCase.levelId)?.name ?? "Test Cases";

  function discardChanges() {
    syncFromServer(testCase, detail.data!.steps, detail.data!.directRequirementIds);
  }

  return (
    <>
      <ProductContextStrip productId={testCase.productId} artifact="testCases" activeLevelId={testCase.levelId} />
      {/* Extra bottom padding clears the fixed Save/Discard bar at the end of the form -
          otherwise it would sit on top of (and hide) whatever's last on the page, e.g. the
          execution history list once you've scrolled all the way down. */}
      <main className="mx-auto max-w-4xl px-4 pt-10 pb-24">
      <div className="flex items-center justify-between">
        <Link
          href={`/products/${testCase.productId}?artifact=testCases&level=${testCase.levelId}`}
          className="text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          ← Back to {levelName}
        </Link>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:text-destructive"
          disabled={deleteTestCase.isPending}
          onClick={() => {
            if (
              !confirm(`Delete ${formatItemId(testCase.levelCode, testCase.sequenceNumber)} "${testCase.title}"? This cannot be undone.`)
            ) {
              return;
            }
            deleteTestCase.mutate(
              { id },
              {
                onSuccess: () => router.push(`/products/${testCase.productId}?artifact=testCases&level=${testCase.levelId}`),
              },
            );
          }}
        >
          {deleteTestCase.isPending ? "Deleting..." : "Delete"}
        </Button>
      </div>
      {deleteTestCase.error && <p className="mt-2 text-sm text-destructive">{deleteTestCase.error.message}</p>}

      <div className="mt-3">
        <GenerateDocumentButton scope="test_case" buildRequestBody={() => ({ testCaseId: id })} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          updateTestCase.mutate({
            testCaseId: id,
            testType,
            title,
            requirementIds: requirementIds.length ? requirementIds : undefined,
            steps: steps.map((s) => ({
              id: s.id,
              description: s.description,
              expectedResult: s.expectedResult,
              purpose: s.purpose || undefined,
              requirementIds: s.requirementIds.length ? s.requirementIds : undefined,
            })),
          });
        }}
        className="mt-4 space-y-6"
      >
        <p className="font-mono text-xs font-semibold text-primary">{formatItemId(testCase.levelCode, testCase.sequenceNumber)}</p>
        <div className="flex gap-3">
          <div className="flex-1 space-y-1.5">
            <Label className="text-xs font-medium text-muted-foreground">Title</Label>
            <Input required value={title} onChange={(e) => setTitle(e.target.value)} className="text-base font-semibold" />
          </div>
          <div className="w-44 space-y-1.5">
            <Label className="text-xs font-medium text-muted-foreground">Type</Label>
            <Select value={testType} onValueChange={(v) => setTestType(v as typeof testType)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="verification">Verification</SelectItem>
                <SelectItem value="validation">Validation</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {effectiveRequirementLinks.length > 0 && (
          <p className="text-sm text-muted-foreground">
            Traces to:{" "}
            {effectiveRequirementLinks.map((r, i) => (
              <span key={r.id}>
                {i > 0 && ", "}
                <Link href={`/requirements/${r.id}`} className="text-primary underline-offset-2 hover:underline">
                  {formatItemId(r.levelCode, r.sequenceNumber)}: {r.title}
                </Link>
              </span>
            ))}
          </p>
        )}

        <Label className="flex-col items-start gap-1">
          <span className="text-xs font-medium text-muted-foreground">
            Linked requirements (applies to the whole test case, independent of any step link)
          </span>
          <RequirementPicker
            options={requirementOptions.data ?? []}
            value={requirementIds}
            onChange={setRequirementIds}
          />
        </Label>

        <div className="space-y-3">
          <h2 className="text-sm font-medium text-foreground">Steps</h2>
          <TestStepsEditor steps={steps} onChange={setSteps} requirementOptions={requirementOptions.data ?? []} />
        </div>

        {updateTestCase.error && <p className="text-sm text-destructive">{updateTestCase.error.message}</p>}

        {/* `fixed`, not just at the end of the form - a test case can run to dozens of
            steps, so Save/Discard stay reachable without scrolling, from anywhere on the
            page (not just `sticky`, which would stop tracking past the form itself). z-40,
            one below the z-50 popups/dropdowns use, so an open one still renders on top. */}
        <div className="fixed inset-x-0 bottom-0 z-40 border-t bg-background">
          <div className="mx-auto flex max-w-4xl items-center gap-2 px-4 py-3">
            <Button type="submit" disabled={updateTestCase.isPending || !isDirty}>
              {updateTestCase.isPending ? "Saving..." : "Save changes"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={discardChanges}
              disabled={updateTestCase.isPending || !isDirty}
            >
              Discard changes
            </Button>
          </div>
        </div>
      </form>

      <Card className="mt-8 flex-row items-end gap-2 p-4">
        <div className="flex-1 space-y-1.5">
          <Label>Environment</Label>
          <Select value={environmentId} onValueChange={(v) => setEnvironmentId(v ?? "")}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select environment" />
            </SelectTrigger>
            <SelectContent>
              {environments.data?.map((env) => (
                <SelectItem key={env.id} value={env.id}>
                  {env.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {/* An invisible label matching the field's, not `items-end` alone - makes the
            button's own column the same height as the field's column (label row + control
            row) so the two controls' bottoms line up exactly, rather than relying on flex
            cross-axis alignment to guess it from unequal-height siblings. */}
        <div className="space-y-1.5">
          <Label className="invisible">Run</Label>
          <Button
            disabled={!environmentId || startExecution.isPending}
            onClick={() => {
              // Starting a run navigates straight to the execution page via `router.push`
              // on success (see startExecution's onSuccess above), not an <a> click, so
              // useUnsavedChangesGuard's click interceptor never sees it - check directly.
              if (
                isDirty &&
                !window.confirm("You have unsaved changes on this test case. Start the run without saving them?")
              ) {
                return;
              }
              startExecution.mutate({ testCaseId: id, environmentId });
            }}
          >
            {startExecution.isPending ? "Starting..." : "Run test"}
          </Button>
        </div>
      </Card>
      {startExecution.error && <p className="mt-2 text-sm text-destructive">{startExecution.error.message}</p>}

      {customFieldDefs.length > 0 && (
        <Card className="mt-8 p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-foreground">Custom fields</h2>
            {!editingCustomFields && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setCustomFieldState(customFieldFormStateFromValues(customFieldValues));
                  setEditingCustomFields(true);
                }}
              >
                Edit
              </Button>
            )}
          </div>
          {editingCustomFields ? (
            <form
              className="mt-3 space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                updateCustomFieldValues.mutate(
                  { testCaseId: id, values: toCustomFieldValuesInput(customFieldState) },
                  { onSuccess: () => setEditingCustomFields(false) },
                );
              }}
            >
              <CustomFieldInputs
                fields={customFieldDefs}
                state={customFieldState}
                onChange={(fieldId, value) => setCustomFieldState((s) => ({ ...s, [fieldId]: value }))}
              />
              {updateCustomFieldValues.error && (
                <p className="text-sm text-destructive">{updateCustomFieldValues.error.message}</p>
              )}
              <div className="flex gap-2">
                <Button type="submit" disabled={updateCustomFieldValues.isPending}>
                  Save
                </Button>
                <Button type="button" variant="ghost" onClick={() => setEditingCustomFields(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <dl className="mt-3 space-y-2 text-sm">
              {customFieldValues.map((v) => (
                <div key={v.fieldId} className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">{v.name}</dt>
                  <dd className="text-right text-foreground">{formatCustomFieldValue(v)}</dd>
                </div>
              ))}
            </dl>
          )}
        </Card>
      )}

      <h2 className="mt-10 text-sm font-medium text-foreground">Execution history</h2>
      <ul className="mt-3 divide-y divide-border overflow-hidden rounded-md border text-sm">
        {executions.map((ex) => (
          <li key={ex.id} className="flex items-center gap-2 px-3 py-1">
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
              aria-label={`Select execution from ${new Date(ex.startedAt).toLocaleString()}`}
            />
            <Link
              href={`/test-cases/${id}/executions/${ex.id}`}
              className="flex flex-1 items-center justify-between gap-3 rounded py-1.5 transition-colors hover:bg-muted/50"
            >
              <span>
                {ex.environmentName} · {new Date(ex.startedAt).toLocaleString()}
              </span>
              <ResultBadge status={ex.status} />
            </Link>
          </li>
        ))}
      </ul>
      {executions.length === 0 && <p className="text-sm text-muted-foreground">No executions yet.</p>}
      {selectedExecutionIds.size > 0 && (
        <div className="mt-3">
          <BulkGenerateDocumentButton
            scope="test_execution"
            ids={[...selectedExecutionIds]}
            onDone={() => setSelectedExecutionIds(new Set())}
          />
        </div>
      )}
      </main>
    </>
  );
}
