"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc-client";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

type Scope = "test_case" | "test_execution" | "requirement_list" | "ots_list" | "ots_component";

/** The synthetic anchor's `download` attribute is what makes this a save-to-disk rather
 * than a navigation - `useUnsavedChangesGuard`'s own click listener knows to leave
 * download anchors alone for exactly that reason (see its own comment for the bug that
 * fixes: this click was otherwise indistinguishable from clicking a real in-app link,
 * which popped a spurious "leaving this page" confirm right as an export finished). */
function triggerBlobDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

/** Imperative handle (backlog item 9.35 - "closing the modal or leaving the page should
 * cancel [an in-progress export], but asking for confirmation first") so a caller that
 * doesn't otherwise touch this component's internals can still interrupt an in-flight
 * export - the caller (GenerateDocumentButton/BulkGenerateDocumentButton) owns the
 * confirm() prompt and the decision to actually cancel, since it's the one that knows
 * *why* it wants to (the dialog is closing, or the page is being left); this just carries
 * out the cancellation once asked. */
export interface DocumentGenerationWizardHandle {
  cancel: () => void;
}

/**
 * The two-step "pick a template, then fill in its fields and export" wizard body
 * (backlog item 9.33 - moved from an always-visible inline form into a modal, per the
 * user's feedback that an infrequently-used export form was cluttering the page).
 * Shared by both `GenerateDocumentButton` (one document) and `BulkGenerateDocumentButton`
 * (many, zipped) - each wraps this in its own `Dialog`/trigger button and supplies the
 * fetch URL and the scope-specific request fields; this owns only template selection,
 * parameter entry, and the actual export sequence (including, for a batch, reading a
 * progress stream - see `streaming` below).
 *
 * Skips straight to the parameter step when there's exactly one template - "choose
 * between one option" isn't a real step. Switching templates mid-export is refused (the
 * "← Choose a different template" button is disabled while `isGenerating`) - the
 * in-flight request is for the *current* selection; letting the operator pick a
 * different one out from under it would leave the export running against a choice no
 * longer shown on screen.
 */
export const DocumentGenerationWizard = forwardRef<
  DocumentGenerationWizardHandle,
  {
    scope: Scope;
    fetchUrl: string;
    /** The request fields specific to this call site - `{ testCaseId }`, `{ executionId }`,
     * `{ testCaseIds }`, `{ executionIds }`, or the requirement-list trio - merged with
     * `templateId`/`paramValues` at export time. */
    extraBody: Record<string, unknown>;
    /** Used only if the server response has no filename of its own (shouldn't normally
     * happen, but a download needs *some* name). */
    fallbackFilename: string;
    /** True for the bulk route (backlog item 9.34): the response is newline-delimited JSON
     * progress events ending in a `done`/`error` line, not a plain file - see that route's
     * own docstring for the exact protocol. False (the default) reads the response as a
     * plain downloadable file directly, no progress to report for one document. */
    streaming?: boolean;
    /** Called after a successful export - the caller typically closes the dialog. */
    onGenerated?: () => void;
    /** Mirrors `isGenerating` out to the caller (backlog item 9.35) - it needs to know
     * whether an export is in flight to decide whether closing the dialog or leaving the
     * page needs a confirmation first, without owning the export logic itself. */
    onGeneratingChange?: (generating: boolean) => void;
  }
>(function DocumentGenerationWizard(
  { scope, fetchUrl, extraBody, fallbackFilename, streaming, onGenerated, onGeneratingChange },
  ref,
) {
  const templates = trpc.documentTemplates.list.useQuery({ scope });
  const [step, setStep] = useState<"template" | "params">("template");
  const [templateId, setTemplateId] = useState("");
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const [isGenerating, setIsGeneratingState] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  function setIsGenerating(value: boolean) {
    setIsGeneratingState(value);
    onGeneratingChange?.(value);
  }

  useImperativeHandle(ref, () => ({
    cancel: () => abortControllerRef.current?.abort(),
  }));

  const list = templates.data ?? [];
  useEffect(() => {
    if (list.length === 1 && !templateId) {
      setTemplateId(list[0]!.id);
      setStep("params");
    }
  }, [list, templateId]);

  if (templates.isLoading) {
    return <p className="px-1 py-2 text-sm text-muted-foreground">Loading templates...</p>;
  }
  if (list.length === 0) {
    return (
      <p className="px-1 py-2 text-sm text-muted-foreground">
        No templates defined for this yet - add one in Settings → Document templates.
      </p>
    );
  }

  const selected = list.find((t) => t.id === templateId);

  /** Plain path: the response body itself is the file. Used for one-document exports,
   * where there's exactly one step and no meaningful progress to show partway through. */
  async function exportPlain(res: Response) {
    const blob = await res.blob();
    const filenameMatch = res.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/);
    triggerBlobDownload(blob, filenameMatch?.[1] ?? fallbackFilename);
  }

  /** Streaming path (backlog item 9.34): reads newline-delimited JSON off the response
   * body as it arrives, updating `progress` after each completed target, until a final
   * `done` (decode its base64 zip and download it) or `error` line. A manual reader loop,
   * not `res.json()` - the whole point is seeing each line *as it arrives*, not waiting
   * for the connection to close first. */
  async function exportStreaming(res: Response) {
    const reader = res.body?.getReader();
    if (!reader) throw new Error("streaming not supported by this browser");
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done: streamDone, value } = await reader.read();
      if (streamDone) break;
      buffer += decoder.decode(value, { stream: true });
      for (let newlineAt = buffer.indexOf("\n"); newlineAt >= 0; newlineAt = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newlineAt);
        buffer = buffer.slice(newlineAt + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as
          | { type: "progress"; done: number; total: number }
          | { type: "done"; filename: string; zipBase64: string }
          | { type: "error"; message: string };
        if (msg.type === "progress") setProgress({ done: msg.done, total: msg.total });
        else if (msg.type === "error") throw new Error(msg.message);
        else if (msg.type === "done") {
          const binary = atob(msg.zipBase64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          triggerBlobDownload(new Blob([bytes], { type: "application/zip" }), msg.filename);
        }
      }
    }
  }

  async function generate() {
    if (!selected) return;
    setError(null);
    setProgress(streaming ? { done: 0, total: extraBodyTotal(extraBody) } : null);
    setIsGenerating(true);
    const controller = new AbortController();
    abortControllerRef.current = controller;

    let succeeded = false;
    try {
      const res = await fetch(fetchUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateId: selected.id, paramValues, ...extraBody }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "export failed" }));
        throw new Error(body.error ?? "export failed");
      }
      if (streaming) await exportStreaming(res);
      else await exportPlain(res);
      succeeded = true;
    } catch (err) {
      // A cancellation the operator asked for isn't a failure worth an error message -
      // the dialog is closing (or already closed) either way.
      if (!isAbortError(err)) setError(err instanceof Error ? err.message : "export failed");
    }

    // Cleared *before* onGenerated below, not after - onGenerated triggers the actual
    // download and typically closes the dialog, and closing it can synchronously re-check
    // "is an export still running" (see useExportDialogGuard's confirmClose) before this
    // function would otherwise get a chance to clear that flag. `setIsGenerating` also
    // calls `onGeneratingChange` synchronously (not on a later render), so by the time
    // onGenerated runs, the caller's own copy of this flag is already correct - this is
    // what stops a completed export from wrongly triggering "cancel this export?".
    abortControllerRef.current = null;
    setIsGenerating(false);
    setProgress(null);
    if (succeeded) onGenerated?.();
  }

  if (step === "template" || !selected) {
    return (
      <div className="space-y-1">
        <p className="mb-1 text-xs font-medium text-muted-foreground">Choose a template</p>
        {list.map((t) => (
          <button
            key={t.id}
            type="button"
            className="block w-full rounded-md border px-3 py-2 text-left text-sm hover:bg-muted"
            onClick={() => {
              setTemplateId(t.id);
              setStep("params");
            }}
          >
            {t.name}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {list.length > 1 && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="-ml-2"
          disabled={isGenerating}
          onClick={() => setStep("template")}
        >
          ← Choose a different template
        </Button>
      )}
      <p className="text-sm font-medium text-foreground">{selected.name}</p>
      {selected.parameters.length > 0 && (
        <div className="space-y-2">
          {selected.parameters.map((p) => (
            <label key={p.id} className="flex flex-col gap-1 text-xs text-muted-foreground">
              {p.label}
              {p.isRequired ? " *" : ""}
              <Input
                type={p.type === "date" ? "date" : "text"}
                value={paramValues[p.key] ?? ""}
                onChange={(e) => setParamValues((v) => ({ ...v, [p.key]: e.target.value }))}
                className="h-8 text-sm"
                disabled={isGenerating}
              />
            </label>
          ))}
        </div>
      )}
      {progress && (
        <div>
          <progress className="h-1.5 w-full accent-primary" value={progress.done} max={progress.total} />
          <p className="mt-1 text-xs text-muted-foreground">
            Exporting {progress.done} of {progress.total}...
          </p>
        </div>
      )}
      <div className="flex justify-end">
        <Button type="button" disabled={isGenerating} onClick={generate}>
          {isGenerating ? "Exporting..." : "Export"}
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
});

/** The progress bar's denominator is known upfront (however many ids were selected) -
 * read directly out of `extraBody` rather than threaded through as a separate prop, so
 * callers don't have to pass the same count twice. */
function extraBodyTotal(extraBody: Record<string, unknown>): number {
  const ids = (extraBody.testCaseIds ?? extraBody.executionIds) as unknown[] | undefined;
  return ids?.length ?? 1;
}

/**
 * Shared by both `GenerateDocumentButton` and `BulkGenerateDocumentButton` (backlog item
 * 9.35 - "closing the modal or leaving the page should cancel [an in-progress export],
 * but asking for confirmation first") so the confirmation wording and cancellation
 * mechanics live in exactly one place rather than being reimplemented per caller.
 *
 * - Leaving the page entirely (an actual navigation, not just closing the dialog) reuses
 *   `useUnsavedChangesGuard` wholesale - an export in progress is treated exactly like an
 *   unsaved form: a native "leave site?" prompt on tab close/refresh, a `confirm()` gate
 *   on in-app link clicks. It doesn't itself cancel anything - browser navigation away
 *   from the page tears down the request regardless of what this code does.
 * - Closing the dialog while exporting (Escape, the X button, clicking outside, or a
 *   caller explicitly calling `requestClose(false)`) is different: the page hasn't gone
 *   anywhere, so *this* code has to actually cancel the in-flight request itself
 *   (`wizardRef.current.cancel()`, which aborts the underlying fetch - see the wizard's
 *   own `AbortController`) once the operator confirms that's really what they want.
 */
export function useExportDialogGuard() {
  const wizardRef = useRef<DocumentGenerationWizardHandle>(null);
  const [isGenerating, setIsGeneratingState] = useState(false);
  // A ref alongside the state, read by confirmClose below instead of the state itself -
  // `onOpenChange` can fire synchronously (e.g. triggered by the wizard's own download
  // mechanics right as an export finishes), before React has committed a re-render off
  // the back of `setIsGeneratingState`. Reading the ref instead means confirmClose always
  // sees the value as of the *last actual call* to setIsGenerating, not a stale value
  // captured by whichever render's closure happened to create this confirmClose - this is
  // what fixes a real bug: a just-completed export could still trip "cancel this
  // export?" if the close attempt was handled before that render landed.
  const isGeneratingRef = useRef(false);

  function setIsGenerating(value: boolean) {
    isGeneratingRef.current = value;
    setIsGeneratingState(value);
  }

  useUnsavedChangesGuard(isGenerating, "An export is in progress - leaving this page will cancel it. Leave anyway?");

  /** Call from a Dialog's `onOpenChange` before actually flipping the open state - returns
   * whether the close should proceed (always true when not generating; asks first, and
   * cancels the export, when it is). */
  function confirmClose(nextOpen: boolean): boolean {
    if (nextOpen || !isGeneratingRef.current) return true;
    if (!window.confirm("An export is in progress. Cancel it?")) return false;
    wizardRef.current?.cancel();
    return true;
  }

  return { wizardRef, isGenerating, setIsGenerating, confirmClose };
}
