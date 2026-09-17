"use client";

import { AiStepAssistBody } from "@/components/ai-tools-panel";
import type { RequirementOption } from "@/components/requirement-picker";
import { RichTextEditor } from "@/components/rich-text-editor";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { StepDraft } from "@/components/test-steps-editor";
import { htmlToPlainText } from "@/lib/text-diff";
import { trpc } from "@/lib/trpc-client";
import { cn } from "cn";
import Link from "next/link";
import { useEffect, useState } from "react";

type RailTab = "run" | "ai" | "history";
const TAB_PREF_KEY = "alm4devs:contextRailTab";

function getPreferredTab(): RailTab | null {
  try {
    const raw = localStorage.getItem(TAB_PREF_KEY);
    return raw === "run" || raw === "ai" || raw === "history" ? raw : null;
  } catch {
    return null;
  }
}
function savePreferredTab(tab: RailTab): void {
  try {
    localStorage.setItem(TAB_PREF_KEY, tab);
  } catch {
    // Private browsing / storage disabled - not remembering is a fine degradation.
  }
}

export interface RailExecution {
  id: string;
  status: string;
  startedAt: string | Date;
  completedAt: string | Date | null;
  environmentName: string;
}

/**
 * The docked right-hand context rail (design_handoff_shell_restructure/README.md's "2d"/
 * "2e") - Run | AI | History, replacing both the floating AI tools panel and the inline
 * "Run test" card on the test case detail page. All three tabs stay mounted at once,
 * toggled with `hidden`, not a conditional return picking one - the AI tab in particular
 * holds an in-progress conversation in its own state that a real unmount would discard
 * (see ai-tools-panel.tsx's own docstring, which used to make this same point about its
 * old floating-panel wrapper).
 *
 * `executions` is the test case's own execution list, already fetched by the caller
 * (`testCases.get`) - passed in rather than re-queried here, same "don't duplicate a
 * query the page already made" convention used elsewhere in this app. The most recent
 * execution without a `completedAt` (if any) is treated as the open run.
 */
export function ContextRail({
  testCaseId,
  productId,
  testCaseTitle,
  testCaseDisplayId,
  steps,
  onAcceptAiSteps,
  requirementOptions,
  executions,
  isDirty,
}: {
  testCaseId: string;
  productId: string;
  testCaseTitle?: string;
  testCaseDisplayId?: string;
  steps: StepDraft[];
  onAcceptAiSteps: (steps: StepDraft[]) => void;
  requirementOptions: RequirementOption[];
  executions: RailExecution[];
  isDirty: boolean;
}) {
  const [tab, setTab] = useState<RailTab>("run");
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    const preferred = getPreferredTab();
    if (preferred) setTab(preferred);
    setHydrated(true);
  }, []);
  useEffect(() => {
    if (hydrated) savePreferredTab(tab);
  }, [tab, hydrated]);

  const openExecution = executions.find((e) => !e.completedAt) ?? null;

  return (
    <aside className="w-[352px] flex-none border-l border-border p-5">
      <div className="flex border border-border bg-card">
        <TabButton active={tab === "run"} onClick={() => setTab("run")}>
          Run
        </TabButton>
        <TabButton active={tab === "ai"} onClick={() => setTab("ai")}>
          AI
        </TabButton>
        <TabButton active={tab === "history"} onClick={() => setTab("history")}>
          History
        </TabButton>
      </div>

      <div className="mt-2" hidden={tab !== "run"}>
        <RunTab testCaseId={testCaseId} openExecution={openExecution} stepCount={steps.length} isDirty={isDirty} />
      </div>
      <div className="mt-2" hidden={tab !== "ai"}>
        <AiStepAssistBody
          productId={productId}
          testCaseTitle={testCaseTitle}
          testCaseDisplayId={testCaseDisplayId}
          steps={steps}
          requirementOptions={requirementOptions}
          onAccept={onAcceptAiSteps}
        />
      </div>
      <div className="mt-2" hidden={tab !== "history"}>
        <HistoryTab testCaseId={testCaseId} executions={executions} />
      </div>
    </aside>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex-1 border-l border-border py-1 font-heading text-[12.5px] tracking-[0.1em] uppercase first:border-l-0",
        active ? "bg-foreground text-background" : "text-muted-foreground",
      )}
    >
      {children}
    </button>
  );
}

function RunTab({
  testCaseId,
  openExecution,
  stepCount,
  isDirty,
}: {
  testCaseId: string;
  openExecution: RailExecution | null;
  stepCount: number;
  isDirty: boolean;
}) {
  const utils = trpc.useUtils();
  const environments = trpc.testCases.listEnvironments.useQuery();
  const [environmentId, setEnvironmentId] = useState("");
  const startExecution = trpc.testCases.startExecution.useMutation({
    onSuccess: () => utils.testCases.get.invalidate({ id: testCaseId }),
  });

  if (openExecution) return <RunInProgressPanel executionId={openExecution.id} environmentName={openExecution.environmentName} />;

  return (
    <div className="space-y-2.5 border border-border bg-card p-3">
      <p className="text-[13px] text-muted-foreground">Environment</p>
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
      <Button
        className="w-full"
        disabled={!environmentId || startExecution.isPending}
        onClick={() => {
          // Same guard the old inline "Run test" card had - a run snapshots the
          // *persisted* steps, not whatever's unsaved in the editor right now.
          if (isDirty && !window.confirm("You have unsaved changes on this test case. Start the run without saving them?")) {
            return;
          }
          startExecution.mutate({ testCaseId, environmentId });
        }}
      >
        {startExecution.isPending ? "Starting…" : "Start run"}
      </Button>
      <p className="text-[12.5px] text-muted-foreground">
        Snapshots the {stepCount} step{stepCount === 1 ? "" : "s"} as they are now.
      </p>
      {startExecution.error && <p className="text-sm text-destructive">{startExecution.error.message}</p>}
    </div>
  );
}

/** The step roster + active-step record box for an open execution - shared between the
 * rail's Run tab and the standalone execution page (`executions/[executionId]/page.tsx`),
 * so a direct link to that route renders in the same grammar instead of the old
 * card-per-step layout it used to have. Recording is one step at a time (the active row,
 * defaulting to the first not-yet-recorded one) rather than every step editable
 * simultaneously - a real interaction change from before, not just a restyle, per the
 * design handoff's own "2d" proposal. */
function useExecutionData(executionId: string) {
  const query = trpc.testCases.getExecution.useQuery({ id: executionId });
  return { execution: query.data?.execution, stepExecutions: query.data?.stepExecutions ?? [], query };
}

export function RunInProgressPanel({ executionId, environmentName }: { executionId: string; environmentName?: string }) {
  const utils = trpc.useUtils();
  const { execution, stepExecutions, query } = useExecutionData(executionId);
  const completeExecution = trpc.testCases.completeExecution.useMutation({
    onSuccess: () => utils.testCases.getExecution.invalidate({ id: executionId }),
  });
  const [activeStepId, setActiveStepId] = useState<string | null>(null);

  if (query.isLoading) return <p className="text-[13.5px] text-muted-foreground">Loading…</p>;
  if (query.error || !execution) return <p className="text-sm text-destructive">{query.error?.message}</p>;

  const firstNotRun = stepExecutions.find((se) => se.status === "not_run");
  const activeStep = stepExecutions.find((se) => se.id === activeStepId) ?? firstNotRun ?? stepExecutions[0];
  const recordedCount = stepExecutions.filter((se) => se.status !== "not_run").length;
  const allRecorded = recordedCount === stepExecutions.length;

  return (
    <div className="space-y-2.5">
      <h5 className="font-heading text-[13px] tracking-[0.14em] text-muted-foreground uppercase">Run in progress</h5>
      <div className="border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-2.5 py-2 text-[13px]">
          <span>
            {environmentName ? `${environmentName} · ` : ""}started{" "}
            {new Date(execution.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
          <span className="border border-primary px-1.5 font-mono text-[11px] font-medium text-accent-tint-foreground">
            {recordedCount}/{stepExecutions.length}
          </span>
        </div>
        {stepExecutions.map((se, i) => (
          <button
            key={se.id}
            type="button"
            onClick={() => setActiveStepId(se.id)}
            className={cn(
              "flex w-full items-center gap-2.5 border-b border-foreground/9 px-2.5 py-[7px] text-left text-[13.5px] last:border-0",
              activeStep?.id === se.id && "bg-primary/8",
            )}
          >
            <ResultSquare status={se.status} />
            <span className="font-mono text-[11.5px] text-muted-foreground">{String(i + 1).padStart(2, "0")}</span>
            <span className="min-w-0 flex-1 truncate">{htmlToPlainText(se.descriptionSnapshot)}</span>
            <span className="text-xs text-muted-foreground">
              {se.id === activeStep?.id && se.status === "not_run" ? "record" : se.status.replaceAll("_", " ")}
            </span>
          </button>
        ))}
      </div>

      {activeStep && (
        <ActiveStepRecorder
          key={activeStep.id}
          stepExecution={activeStep}
          executionId={executionId}
          stepNumber={stepExecutions.findIndex((se) => se.id === activeStep.id) + 1}
        />
      )}

      {!execution.completedAt && (
        <div>
          <Button
            className="w-full"
            disabled={!allRecorded || completeExecution.isPending}
            onClick={() => completeExecution.mutate({ executionId })}
          >
            {completeExecution.isPending ? "Completing…" : "Complete execution"}
          </Button>
          {!allRecorded && (
            <p className="mt-1.5 text-[12.5px] text-muted-foreground">Record a result for every step before completing.</p>
          )}
          {completeExecution.error && <p className="mt-1.5 text-sm text-destructive">{completeExecution.error.message}</p>}
        </div>
      )}
    </div>
  );
}

type StepExecution = ReturnType<typeof useExecutionData>["stepExecutions"][number];

function ActiveStepRecorder({
  stepExecution,
  executionId,
  stepNumber,
}: {
  stepExecution: StepExecution;
  executionId: string;
  stepNumber: number;
}) {
  const utils = trpc.useUtils();
  const recordResult = trpc.testCases.recordStepResult.useMutation({
    onSuccess: () => utils.testCases.getExecution.invalidate({ id: executionId }),
  });

  const [actualResult, setActualResult] = useState(stepExecution.actualResult ?? "");
  const [status, setStatus] = useState<"pass" | "fail" | "blocked">(
    stepExecution.status === "not_run" ? "pass" : (stepExecution.status as "pass" | "fail" | "blocked"),
  );
  const [uploading, setUploading] = useState(false);

  function save() {
    if (!actualResult.trim() || recordResult.isPending) return;
    recordResult.mutate({ testStepExecutionId: stepExecution.id, actualResult, status });
  }

  // A real ⌘↵ handler, not just a label claiming one exists (see the design handoff's
  // "only claim the keys you actually wire up" rule) - scoped to while this step's
  // recorder is mounted, since `key` on the parent already remounts it per active step.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        save();
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
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="border border-border bg-background p-2.5">
      <p className="mb-1.5 font-mono text-[10.5px] tracking-[0.12em] text-muted-foreground uppercase">
        Step {String(stepNumber).padStart(2, "0")} · Actual result
      </p>
      <RichTextEditor compact value={actualResult} onChange={setActualResult} stepExecutionId={stepExecution.id} />
      <div className="mt-2 flex gap-1.5">
        {(["pass", "fail", "blocked"] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatus(s)}
            className={cn(
              "flex-1 border py-1 text-center font-mono text-[11.5px] font-medium uppercase",
              status === s ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground",
            )}
          >
            {s}
          </button>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between text-[12.5px] text-muted-foreground">
        <label className="cursor-pointer hover:text-foreground">
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
        <button
          type="button"
          onClick={save}
          disabled={recordResult.isPending || !actualResult.trim()}
          className="font-mono disabled:opacity-45"
        >
          {recordResult.isPending ? "saving…" : "⌘↵ save"}
        </button>
      </div>
      {recordResult.error && <p className="mt-1.5 text-xs text-destructive">{recordResult.error.message}</p>}
      {stepExecution.evidence.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
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
  );
}

function HistoryTab({ testCaseId, executions }: { testCaseId: string; executions: RailExecution[] }) {
  if (executions.length === 0) return <p className="text-[13.5px] text-muted-foreground">No executions yet.</p>;
  return (
    <div className="border-t border-border">
      {executions.map((ex) => (
        <Link
          key={ex.id}
          href={`/test-cases/${testCaseId}/executions/${ex.id}`}
          className="flex items-center justify-between border-b border-border py-1.5 text-[13.5px] hover:bg-primary/6"
        >
          <span>
            {new Date(ex.startedAt).toLocaleDateString()} · {ex.environmentName}
          </span>
          <span className="flex items-center gap-1.5">
            <ResultSquare status={ex.status} />
            <span className="text-xs text-muted-foreground">{ex.status.replaceAll("_", " ")}</span>
          </span>
        </Link>
      ))}
    </div>
  );
}

/** The 9px result square used throughout the rail - accent fill for a pass, ink fill for
 * a fail, hairline outline (accent border, no fill) for anything not yet run. Same
 * fill/outline/ink "coded by form" convention as status-pill.tsx/result-badge.tsx. */
export function ResultSquare({ status }: { status: string }) {
  const filled = status === "pass" || status === "fail";
  return (
    <span
      className={cn(
        "size-[9px] shrink-0 border",
        status === "pass" && "border-primary bg-primary",
        status === "fail" && "border-foreground bg-foreground",
        !filled && "border-primary bg-transparent",
      )}
    />
  );
}
