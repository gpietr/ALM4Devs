"use client";

import { AiStepAssistBody } from "@/components/ai-tools-panel";
import type { RequirementOption } from "@/components/requirement-picker";
import { Button, buttonVariants } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { StepDraft } from "@/components/test-steps-editor";
import { trpc } from "@/lib/trpc-client";
import { cn } from "cn";
import Link from "next/link";
import { useRouter } from "next/navigation";
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
  const router = useRouter();
  const utils = trpc.useUtils();
  const environments = trpc.testCases.listEnvironments.useQuery();
  const [environmentId, setEnvironmentId] = useState("");
  const startExecution = trpc.testCases.startExecution.useMutation({
    onSuccess: ({ execution }) => {
      utils.testCases.get.invalidate({ id: testCaseId });
      router.push(`/test-cases/${testCaseId}/executions/${execution.id}`);
    },
  });

  // Recording itself only happens in the full "protocol" layout (TestRunView, at the
  // standalone executions/[executionId] route) - has room for the roster and recorder
  // side by side, which this 352px-wide rail doesn't. So an open execution here is just a
  // pointer to go finish it there, not the compact RunInProgressPanel this used to embed.
  if (openExecution) {
    return (
      <div className="space-y-2.5 border border-border bg-card p-3">
        <p className="text-[13px] text-muted-foreground">
          Run in progress{openExecution.environmentName ? ` · ${openExecution.environmentName}` : ""} · started{" "}
          {new Date(openExecution.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </p>
        <Link href={`/test-cases/${testCaseId}/executions/${openExecution.id}`} className={buttonVariants({ className: "w-full" })}>
          Continue run
        </Link>
      </div>
    );
  }

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
