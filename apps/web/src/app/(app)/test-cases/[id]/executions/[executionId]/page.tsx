"use client";

import { ProductContextStrip } from "@/components/context-strip";
import { GenerateDocumentButton } from "@/components/generate-document-button";
import { ResultBadge } from "@/components/result-badge";
import { RichTextEditor } from "@/components/rich-text-editor";
import { RichTextView } from "@/components/rich-text-view";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { trpc } from "@/lib/trpc-client";
import Link from "next/link";
import { use, useState } from "react";

type StepExecution = ReturnType<typeof useExecutionData>["stepExecutions"][number];

function useExecutionData(executionId: string) {
  const query = trpc.testCases.getExecution.useQuery({ id: executionId });
  return { execution: query.data?.execution, stepExecutions: query.data?.stepExecutions ?? [], query };
}

export default function ExecutionRunPage({
  params,
}: {
  params: Promise<{ id: string; executionId: string }>;
}) {
  const { id: testCaseId, executionId } = use(params);
  const utils = trpc.useUtils();
  const { execution, stepExecutions, query } = useExecutionData(executionId);
  // Only needed for the context strip's product/level - the execution's own steps are
  // already fully loaded via useExecutionData above.
  const testCase = trpc.testCases.get.useQuery({ id: testCaseId });

  const completeExecution = trpc.testCases.completeExecution.useMutation({
    onSuccess: () => utils.testCases.getExecution.invalidate({ id: executionId }),
  });

  if (query.isLoading) return <main className="mx-auto max-w-3xl px-4 py-16 text-sm text-muted-foreground">Loading...</main>;
  if (query.error || !execution) {
    return <main className="mx-auto max-w-3xl px-4 py-16 text-sm text-destructive">{query.error?.message}</main>;
  }

  const allRecorded = stepExecutions.every((se) => se.status !== "not_run");

  return (
    <>
      {testCase.data && (
        <ProductContextStrip
          productId={testCase.data.testCase.productId}
          artifact="testCases"
          activeLevelId={testCase.data.testCase.levelId}
        />
      )}
      <main className="mx-auto max-w-3xl px-4 py-10">
      <Link href={`/test-cases/${testCaseId}`} className="text-sm text-muted-foreground underline underline-offset-2">
        ← Back to test case
      </Link>

      <div className="mt-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Test run</h1>
        <ResultBadge status={execution.status} />
      </div>

      <div className="mt-3">
        <GenerateDocumentButton scope="test_execution" buildRequestBody={() => ({ executionId })} />
      </div>

      <ol className="mt-6 space-y-4">
        {stepExecutions.map((se, i) => (
          <StepExecutionCard key={se.id} stepExecution={se} index={i} executionId={executionId} />
        ))}
      </ol>

      {!execution.completedAt && (
        <div className="mt-8">
          <Button
            disabled={!allRecorded || completeExecution.isPending}
            onClick={() => completeExecution.mutate({ executionId })}
          >
            {completeExecution.isPending ? "Completing..." : "Complete execution"}
          </Button>
          {!allRecorded && (
            <p className="mt-2 text-sm text-muted-foreground">Record a result for every step before completing.</p>
          )}
          {completeExecution.error && <p className="mt-2 text-sm text-destructive">{completeExecution.error.message}</p>}
        </div>
      )}
      </main>
    </>
  );
}

function StepExecutionCard({
  stepExecution,
  index,
  executionId,
}: {
  stepExecution: StepExecution;
  index: number;
  executionId: string;
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

  async function handleEvidenceUpload(file: File) {
    setUploading(true);
    try {
      const res = await fetch(`/api/attachments/upload?stepExecutionId=${stepExecution.id}`, {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream", "X-Filename": file.name },
        body: file,
      });
      if (res.ok) {
        await utils.testCases.getExecution.invalidate({ id: executionId });
      }
    } finally {
      setUploading(false);
    }
  }

  return (
    <li>
      <Card className="p-4">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70">Step {index + 1}</p>
          <ResultBadge status={stepExecution.status} />
        </div>

        <div className="mt-2">
          <p className="text-xs font-medium text-muted-foreground">Description</p>
          <RichTextView html={stepExecution.descriptionSnapshot} />
        </div>
        <div className="mt-2">
          <p className="text-xs font-medium text-muted-foreground">Expected result</p>
          <RichTextView html={stepExecution.expectedResultSnapshot} />
        </div>

        <div className="mt-4 space-y-2">
          <p className="text-xs font-medium text-muted-foreground">Actual result</p>
          <RichTextEditor value={actualResult} onChange={setActualResult} stepExecutionId={stepExecution.id} />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {(["pass", "fail", "blocked"] as const).map((s) => (
            <Button key={s} type="button" size="sm" variant={status === s ? "default" : "outline"} onClick={() => setStatus(s)}>
              {s}
            </Button>
          ))}

          <label className={buttonVariants({ variant: "outline", size: "sm", className: "cursor-pointer" })}>
            {uploading ? "Uploading..." : "Attach evidence"}
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

          <Button
            type="button"
            size="sm"
            disabled={recordResult.isPending || !actualResult.trim()}
            onClick={() => recordResult.mutate({ testStepExecutionId: stepExecution.id, actualResult, status })}
            className="ml-auto"
          >
            {recordResult.isPending ? "Saving..." : "Save result"}
          </Button>
        </div>
        {recordResult.error && <p className="mt-2 text-sm text-destructive">{recordResult.error.message}</p>}

        {stepExecution.evidence.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {stepExecution.evidence.map((ev) => (
              <a
                key={ev.id}
                href={`/api/attachments/${ev.id}`}
                target="_blank"
                rel="noreferrer"
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                {ev.filename}
              </a>
            ))}
          </div>
        )}
      </Card>
    </li>
  );
}
