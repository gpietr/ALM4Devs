"use client";

import { uploadErrorMessage } from "@/lib/upload-error";
import { toast } from "sonner";
import { formatCustomFieldValue } from "@/components/custom-fields";
import { GenerateDocumentButton } from "@/components/generate-document-button";
import { ResultSquare } from "@/components/context-rail";
import { ResultBadge } from "@/components/result-badge";
import { RichTextEditor } from "@/components/rich-text-editor";
import { RichTextView } from "@/components/rich-text-view";
import { Button } from "@/components/ui/button";
import { formatItemId } from "@/lib/format-item-id";
import { htmlToPlainText } from "@/lib/text-diff";
import { trpc } from "@/lib/trpc-client";
import { cn } from "cn";
import { Paperclip } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

export interface RunRequirementLink {
  id: string;
  levelCode: string;
  sequenceNumber: number;
}

/**
 * Full-page "protocol" layout for the standalone execution route
 * (executions/[executionId]/page.tsx) - a PROTOCOL roster down the left and one step's
 * DO THIS / EXPECT THIS / actual-result recorder on the right, replacing that route's old
 * reuse of the docked context rail's compact `RunInProgressPanel`. That panel still backs
 * the rail's own Run tab (see context-rail.tsx) - it has to fit a 352px aside, this owns
 * the whole page and has room to lay the roster and recorder out side by side instead of
 * stacked. Same tRPC procedures underneath (getExecution/recordStepResult/
 * completeExecution), just a different shell around them.
 */
export function TestRunView({
  testCaseId,
  executionId,
  testCaseTitle,
  testCaseDisplayId,
  coverageLinks,
  stepRequirementLinks,
}: {
  testCaseId: string;
  executionId: string;
  testCaseTitle?: string;
  testCaseDisplayId?: string;
  /** The test case's effective requirement coverage (union of case- and step-level
   * links) - shown once in the roster's "Snapshot" note, same "Covers" grammar as the
   * test case detail page. */
  coverageLinks: RunRequirementLink[];
  /** Per-step requirement links, keyed by the *live* test step id (stepExecution.testStepId) -
   * a step can be edited or removed after a run starts, so this reflects the step as it is
   * now, not as it was snapshotted; a step with no match (e.g. deleted since) just shows no
   * "Verifies" chips. */
  stepRequirementLinks: Map<string, RunRequirementLink[]>;
}) {
  const utils = trpc.useUtils();
  const { execution, stepExecutions, query } = useExecutionData(executionId);
  const completeExecution = trpc.testCases.completeExecution.useMutation({
    onSuccess: () => utils.testCases.getExecution.invalidate({ id: executionId }),
  });
  const abandonExecution = trpc.testCases.abandonExecution.useMutation({
    onSuccess: () => utils.testCases.getExecution.invalidate({ id: executionId }),
  });
  const [activeStepId, setActiveStepId] = useState<string | null>(null);
  const firstNotRun = stepExecutions.find((se) => se.status === "not_run");
  // Pins the initial step once data arrives, then leaves activeStepId alone. Without this,
  // "find by id ?? firstNotRun" re-derives firstNotRun on every render - so recording *any*
  // step's result (even via "Save & stay", or a fail that intentionally shouldn't advance)
  // changes that step's status, which silently retargets the view at whatever's now the
  // next not-run step. Once pinned, only an explicit setActiveStepId (roster click, or the
  // deliberate advance/complete calls below) moves the view.
  useEffect(() => {
    const initialStepId = firstNotRun?.id ?? stepExecutions[0]?.id;
    if (activeStepId === null && initialStepId) setActiveStepId(initialStepId);
  }, [activeStepId, stepExecutions, firstNotRun]);

  if (query.isLoading) return <p className="p-10 text-[13.5px] text-muted-foreground">Loading…</p>;
  if (query.error || !execution) return <p className="p-10 text-sm text-destructive">{query.error?.message}</p>;

  const activeStep = stepExecutions.find((se) => se.id === activeStepId) ?? firstNotRun ?? stepExecutions[0];
  const activeIndex = activeStep ? stepExecutions.findIndex((se) => se.id === activeStep.id) : -1;
  const nextStep = activeIndex >= 0 ? (stepExecutions[activeIndex + 1] ?? null) : null;
  const recordedCount = stepExecutions.filter((se) => se.status !== "not_run").length;
  const allRecorded = stepExecutions.length > 0 && recordedCount === stepExecutions.length;

  // Test run parameters (Environment and anything else a tenant has defined) - same
  // "Name: value" summary grammar as test-sets/[id]/page.tsx's item paramsSummary.
  const paramsSummary = execution.customFieldValues
    .filter((v) => v.value != null)
    .map((v) => `${v.name}: ${formatCustomFieldValue(v)}`)
    .join(" · ");

  const metaParts = [
    testCaseDisplayId,
    paramsSummary || undefined,
    `started ${new Date(execution.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
    execution.executedByName ?? undefined,
  ].filter((p): p is string => Boolean(p));

  return (
    <div>
      <div className="flex items-center justify-between gap-4 border-b border-border bg-card px-5 py-3">
        <div className="flex min-w-0 items-center gap-4">
          <Link href={`/test-cases/${testCaseId}`} className="shrink-0 text-[13.5px] text-muted-foreground hover:text-foreground">
            ← Exit run
          </Link>
          <div className="min-w-0">
            <p className="truncate font-mono text-[10.5px] tracking-[0.1em] text-muted-foreground uppercase">{metaParts.join(" · ")}</p>
            <h1 className="truncate font-heading text-[19px] font-semibold text-foreground">{testCaseTitle}</h1>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3.5">
          <div className="text-right">
            <p className="font-mono text-[11px] text-muted-foreground">
              {recordedCount} / {stepExecutions.length} recorded
            </p>
            <div className="mt-1 h-1 w-28 bg-border">
              <div
                className="h-1 bg-primary"
                style={{ width: `${stepExecutions.length ? (recordedCount / stepExecutions.length) * 100 : 0}%` }}
              />
            </div>
          </div>
          <GenerateDocumentButton scope="test_execution" buildRequestBody={() => ({ executionId })} />
          {execution.completedAt ? (
            <ResultBadge status={execution.status} />
          ) : (
            <>
              <Button
                variant="outline"
                disabled={abandonExecution.isPending}
                onClick={() => {
                  if (!confirm("Abandon this run? It'll be marked abandoned and can't be resumed.")) return;
                  abandonExecution.mutate({ executionId });
                }}
              >
                {abandonExecution.isPending ? "Abandoning…" : "Abandon run"}
              </Button>
              <Button
                disabled={!allRecorded || completeExecution.isPending}
                title={!allRecorded ? "Record a result for every step before completing." : undefined}
                onClick={() => completeExecution.mutate({ executionId })}
              >
                {completeExecution.isPending ? "Completing…" : "Complete run"}
              </Button>
            </>
          )}
        </div>
      </div>
      {completeExecution.error && <p className="px-5 pt-2 text-sm text-destructive">{completeExecution.error.message}</p>}
      {abandonExecution.error && <p className="px-5 pt-2 text-sm text-destructive">{abandonExecution.error.message}</p>}

      <div className="flex items-stretch">
        <aside className="w-[300px] flex-none border-r border-border p-4">
          <p className="mb-2 font-heading text-[12px] tracking-[0.14em] text-muted-foreground uppercase">
            Protocol · {stepExecutions.length} step{stepExecutions.length === 1 ? "" : "s"}
          </p>
          <div className="border border-border bg-card">
            {stepExecutions.map((se, i) => (
              <button
                key={se.id}
                type="button"
                onClick={() => setActiveStepId(se.id)}
                className={cn(
                  "flex w-full items-start justify-between gap-2 border-b border-foreground/9 px-2.5 py-2.5 text-left last:border-0",
                  activeStep?.id === se.id && "bg-primary/8",
                )}
              >
                <span className="flex min-w-0 items-start gap-2">
                  <span className="mt-[3px]">
                    <ResultSquare status={se.status} />
                  </span>
                  <span className="min-w-0">
                    <span className="block font-mono text-[10.5px] text-muted-foreground">{String(i + 1).padStart(2, "0")}</span>
                    <span className="block break-words text-[13.5px] leading-snug">{htmlToPlainText(se.descriptionSnapshot)}</span>
                  </span>
                </span>
                <span className="shrink-0 pt-3.5 font-mono text-[10.5px] text-muted-foreground uppercase">
                  {se.id === activeStep?.id && se.status === "not_run" ? "recording" : se.status.replaceAll("_", " ")}
                </span>
              </button>
            ))}
          </div>
          <div className="mt-3 space-y-1.5 text-[12.5px] text-muted-foreground">
            <p className="font-heading text-[11px] tracking-[0.12em] uppercase">Snapshot</p>
            <p>Steps were frozen when the run started. Edits to the test case since then don&apos;t affect this run.</p>
            {coverageLinks.length > 0 && (
              <p>
                Covers{" "}
                {coverageLinks.map((r, i) => (
                  <span key={r.id}>
                    {i > 0 && ", "}
                    <Link href={`/requirements/${r.id}`} className="font-mono text-foreground hover:text-primary">
                      {formatItemId(r.levelCode, r.sequenceNumber)}
                    </Link>
                  </span>
                ))}
              </p>
            )}
          </div>
        </aside>

        <div className="min-w-0 flex-1 p-5">
          {activeStep && (
            <StepRecorder
              key={activeStep.id}
              stepExecution={activeStep}
              executionId={executionId}
              stepNumber={activeIndex + 1}
              totalSteps={stepExecutions.length}
              verifies={stepRequirementLinks.get(activeStep.testStepId) ?? []}
              onAdvance={() => nextStep && setActiveStepId(nextStep.id)}
              isLastStep={nextStep === null}
              onComplete={() => completeExecution.mutate({ executionId })}
              completing={completeExecution.isPending}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function useExecutionData(executionId: string) {
  const query = trpc.testCases.getExecution.useQuery({ id: executionId });
  return { execution: query.data?.execution, stepExecutions: query.data?.stepExecutions ?? [], query };
}

type StepExecution = ReturnType<typeof useExecutionData>["stepExecutions"][number];

function StepRecorder({
  stepExecution,
  executionId,
  stepNumber,
  totalSteps,
  verifies,
  onAdvance,
  isLastStep,
  onComplete,
  completing,
}: {
  stepExecution: StepExecution;
  executionId: string;
  stepNumber: number;
  totalSteps: number;
  verifies: RunRequirementLink[];
  onAdvance: () => void;
  /** Whether this is the last step in the roster - there's nothing to advance to, so the
   * primary button's job changes from "save & move on" to "save & finish the run". */
  isLastStep: boolean;
  onComplete: () => void;
  completing: boolean;
}) {
  const utils = trpc.useUtils();
  const recordResult = trpc.testCases.recordStepResult.useMutation({
    onSuccess: () => utils.testCases.getExecution.invalidate({ id: executionId }),
  });

  const [actualResult, setActualResult] = useState(stepExecution.actualResult ?? "");
  // No default selection - a fresh step shouldn't read as "already marked Pass" before
  // anyone's touched it. Re-opening an already-recorded step still shows its real status.
  const [status, setStatus] = useState<"pass" | "fail" | "blocked" | null>(
    stepExecution.status === "not_run" ? null : (stepExecution.status as "pass" | "fail" | "blocked"),
  );
  const [uploading, setUploading] = useState(false);

  // A pass speaks for itself - only fail/blocked need a note saying what actually
  // happened, same rule the backend enforces (recordStepResult's own refine).
  const canSave = status !== null && (status === "pass" || actualResult.trim().length > 0);

  // `wantsToMoveOn` is the user's intent (true from the quick-status pills, the primary
  // button and ⌘↵, false from "Save & stay"). `viaPill` distinguishes the two places that
  // pass true: the quick-status pills are a fast "mark it" gesture, so fail/blocked never
  // move on from there - a note might already happen to be typed, and completing the run
  // is too big a consequence for an incidental click. The primary button/⌘↵ only enable
  // once a note exists (canSave), so reaching them is always a deliberate "I'm done with
  // this step" - there, fail/blocked move on just like pass. The last step has nothing to
  // advance to anyway, so "moving on" from it means finishing the run instead.
  function save(nextStatus: "pass" | "fail" | "blocked" | null, wantsToMoveOn: boolean, viaPill: boolean) {
    if (nextStatus === null || recordResult.isPending) return;
    if (nextStatus !== "pass" && !actualResult.trim()) return;
    recordResult.mutate(
      { testStepExecutionId: stepExecution.id, actualResult, status: nextStatus },
      {
        onSuccess: () => {
          if (!wantsToMoveOn) return;
          if (viaPill && nextStatus !== "pass") return;
          if (isLastStep) onComplete();
          else onAdvance();
        },
      },
    );
  }

  // A real ⌘↵ handler, same as before - now saves with whichever status is selected and
  // advances, matching "Save & next step" rather than the old plain "save".
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        save(status, true, false);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actualResult, status]);

  async function handleEvidenceUpload(file: File) {
    setUploading(true);
    try {
      const res = await fetch(`/api/attachments/upload?stepExecutionId=${stepExecution.id}`, {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream", "X-Filename": file.name },
        body: file,
      });
      if (res.ok) await utils.testCases.getExecution.invalidate({ id: executionId });
      else toast.error(`Couldn't upload ${file.name}`, { description: await uploadErrorMessage(res) });
    } catch {
      // fetch itself rejected: the connection dropped, or a proxy cut off an oversized body.
      toast.error(`Couldn't upload ${file.name}`, { description: "Upload failed - the file may be too large." });
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-4">
        <p className="font-mono text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
          Step {String(stepNumber).padStart(2, "0")} of {String(totalSteps).padStart(2, "0")}
        </p>
        {verifies.length > 0 && (
          <p className="flex flex-wrap items-center justify-end gap-1.5 text-[12px] text-muted-foreground">
            Verifies
            {verifies.map((r) => (
              <Link
                key={r.id}
                href={`/requirements/${r.id}`}
                className="border border-border px-1.5 py-0.5 font-mono text-[11px] text-foreground hover:border-primary hover:text-primary"
              >
                {formatItemId(r.levelCode, r.sequenceNumber)}
              </Link>
            ))}
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-px border border-border bg-border">
        <div className="bg-background p-3">
          <p className="mb-1.5 font-heading text-[11px] tracking-[0.12em] text-muted-foreground uppercase">Do this</p>
          <RichTextView html={stepExecution.descriptionSnapshot} />
        </div>
        <div className="bg-primary/6 p-3">
          <p className="mb-1.5 font-heading text-[11px] tracking-[0.12em] text-muted-foreground uppercase">Expect this</p>
          <RichTextView html={stepExecution.expectedResultSnapshot} />
        </div>
      </div>

      <div>
        <p className="mb-1.5 font-heading text-[11px] tracking-[0.12em] text-muted-foreground uppercase">What actually happened</p>
        <RichTextEditor value={actualResult} onChange={setActualResult} stepExecutionId={stepExecution.id} />
      </div>

      <div className="flex gap-2">
        {(["pass", "fail", "blocked"] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => {
              setStatus(s);
              save(s, true, true);
            }}
            disabled={recordResult.isPending || completing}
            className={cn(
              "flex-1 border py-2.5 text-center font-mono text-[13px] font-medium uppercase disabled:opacity-60",
              status === s ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground",
            )}
          >
            {/* Only "pass" ever moves you on from here (fail/blocked always stay on this
                step, whatever step it is), so it's the only one worth spelling out. */}
            {s === "pass" ? (isLastStep ? "Pass & complete" : "Pass & next step") : s}
          </button>
        ))}
      </div>

      <div className="flex items-center justify-between gap-3">
        <label className="flex cursor-pointer items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground">
          <Paperclip className="size-3.5" strokeWidth={1.5} />
          {uploading ? "Uploading…" : "Attach evidence"}
          <input
            type="file"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleEvidenceUpload(file);
              e.target.value = "";
            }}
          />
        </label>
        {stepExecution.evidence.length > 0 && (
          <div className="flex flex-wrap justify-end gap-1.5">
            {stepExecution.evidence.map((ev: StepExecution["evidence"][number]) => (
              <a
                key={ev.id}
                href={`/api/attachments/${ev.id}`}
                target="_blank"
                rel="noreferrer"
                className="border border-border px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
              >
                {ev.filename}
              </a>
            ))}
          </div>
        )}
      </div>

      <div className="flex gap-2.5">
        <Button
          className="flex-1"
          disabled={recordResult.isPending || completing || !canSave}
          onClick={() => save(status, true, false)}
        >
          {recordResult.isPending || completing
            ? isLastStep
              ? "Completing…"
              : "Saving…"
            : isLastStep
              ? "Complete run"
              : "Save & next step"}
          <span className="ml-1.5 border border-primary-foreground/45 px-1 font-mono text-[10px] font-normal normal-case">⌘↵</span>
        </Button>
        <Button
          variant="outline"
          className="flex-1"
          disabled={recordResult.isPending || completing || !canSave}
          onClick={() => save(status, false, false)}
        >
          {recordResult.isPending ? "Saving…" : "Save & stay"}
        </Button>
      </div>
      {recordResult.error && <p className="text-sm text-destructive">{recordResult.error.message}</p>}
    </div>
  );
}
