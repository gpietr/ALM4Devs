"use client";

import { RichTextView } from "@/components/rich-text-view";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { RequirementOption } from "@/components/requirement-picker";
import { getAiPanelPrefs, saveAiPanelPrefs } from "@/lib/ai-panel-prefs";
import { formatItemId } from "@/lib/format-item-id";
import { diffHtmlFieldsAsText, diffPlainText, type TextDiffSegment } from "@/lib/text-diff";
import {
  acceptProposal,
  applyStepDelta,
  diffProposedSteps,
  filterKnownRequirementIds,
  stepDraftsToProposedSteps,
  type ProposedStep,
  type StepDiffAction,
  type StepDiffRow,
} from "@/lib/step-diff";
import type { StepDraft } from "@/components/test-steps-editor";
import { cn } from "cn";
import { trpc } from "@/lib/trpc-client";
import { ChevronLeft, ChevronRight, GripVertical } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const MIN_WIDTH = 320;
const MAX_WIDTH = 800;
const DEFAULT_WIDTH = 420;

function clampWidth(width: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width));
}

const ACTION_LABEL: Record<StepDiffAction, string> = {
  added: "added",
  modified: "modified",
  removed: "removed",
  unchanged: "unchanged",
};
const ACTION_VARIANT: Record<StepDiffAction, "success" | "info" | "destructive" | "secondary"> = {
  added: "success",
  modified: "info",
  removed: "destructive",
  unchanged: "secondary",
};

/**
 * A collapsible panel fixed to the right edge of the viewport - floats on top of the
 * page rather than living in its layout flow, so the page never has to resize to make
 * room for it; the user drags it wider instead. "AI tools" (plural) since it's meant as
 * a home for more than just step drafting if more shows up here later.
 *
 * Renders nothing while loading or when no AI connection is configured - same "quietly
 * absent until configured" convention as GenerateDocumentButton. Whether it was left
 * open, and how wide, persists per-device via localStorage (ai-panel-prefs.ts).
 * Collapsing never loses an in-progress conversation - see the `hidden` toggle below.
 */
export function AiToolsPanel({
  productId,
  testCaseTitle,
  steps,
  onAccept,
  requirementOptions,
}: {
  productId: string;
  testCaseTitle?: string;
  steps: StepDraft[];
  onAccept: (steps: StepDraft[]) => void;
  requirementOptions: RequirementOption[];
}) {
  const connection = trpc.llm.getConnection.useQuery();
  const [expanded, setExpanded] = useState(false);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  // Prefs are read from localStorage - not available during server rendering - so this
  // starts false and the real values apply a moment after mount, same as any other
  // client-only-storage read in this app (see last-location.ts's callers). Also guards
  // against writing prefs back out before they've even been read once.
  const [hydrated, setHydrated] = useState(false);
  const dragStateRef = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    const prefs = getAiPanelPrefs();
    if (prefs) {
      setExpanded(prefs.open);
      setWidth(clampWidth(prefs.width));
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    saveAiPanelPrefs({ open: expanded, width });
  }, [expanded, width, hydrated]);

  useEffect(() => {
    function onPointerMove(e: PointerEvent) {
      const drag = dragStateRef.current;
      if (!drag) return;
      // Dragging left (toward the page) makes the right-anchored panel wider, so width
      // grows as clientX shrinks relative to where the drag started.
      setWidth(clampWidth(drag.startWidth + (drag.startX - e.clientX)));
    }
    function onPointerUp() {
      dragStateRef.current = null;
    }
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, []);

  if (connection.isLoading || !connection.data) return null;

  // Both branches stay mounted, toggled with `hidden` - not a conditional return picking
  // one or the other, which would unmount AiStepAssistBody (and its in-progress chat)
  // every time the panel collapses.
  return (
    <>
      <button
        type="button"
        hidden={expanded}
        onClick={() => setExpanded(true)}
        className="fixed top-1/2 right-0 z-[41] flex -translate-y-1/2 items-center gap-1.5 rounded-l-md border border-r-0 bg-card px-2.5 py-3 text-sm font-medium text-foreground shadow-sm hover:bg-muted"
      >
        <ChevronLeft className="size-4" />
        AI tools
      </button>
      <aside
        hidden={!expanded}
        style={{ width }}
        // z-[41]: one above the fixed Save/Discard bar (z-40, test-cases/[id]/page.tsx),
        // one below the z-50 dialogs/dropdowns use everywhere else.
        className="fixed inset-y-0 right-0 z-[41] flex max-w-[90vw] flex-col border-l bg-card shadow-lg"
      >
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize AI tools panel"
          onPointerDown={(e) => {
            e.preventDefault();
            dragStateRef.current = { startX: e.clientX, startWidth: width };
          }}
          className="absolute inset-y-0 -left-1.5 flex w-3 cursor-col-resize touch-none items-center justify-center"
        >
          <GripVertical className="size-3 text-muted-foreground/50" />
        </div>
        <div className="flex items-center justify-between border-b px-3 py-2.5">
          <span className="text-sm font-medium text-foreground">AI tools</span>
          <button
            type="button"
            onClick={() => setExpanded(false)}
            aria-label="Collapse AI tools panel"
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ChevronRight className="size-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <AiStepAssistBody
            productId={productId}
            testCaseTitle={testCaseTitle}
            steps={steps}
            requirementOptions={requirementOptions}
            onAccept={onAccept}
          />
        </div>
      </aside>
    </>
  );
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

function AiStepAssistBody({
  productId,
  testCaseTitle,
  steps,
  requirementOptions,
  onAccept,
}: {
  productId: string;
  testCaseTitle?: string;
  steps: StepDraft[];
  requirementOptions: RequirementOption[];
  onAccept: (steps: StepDraft[]) => void;
}) {
  // Fixed for the length of a conversation - every refinement re-diffs against this
  // same baseline, so the badges always answer "what would change relative to what's
  // really in the editor right now," not "since the last message."
  const [baseline, setBaseline] = useState(steps);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pendingProposal, setPendingProposal] = useState<ProposedStep[] | null>(null);
  const [instructionText, setInstructionText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [truncatedNote, setTruncatedNote] = useState(false);

  const suggest = trpc.testCases.suggestSteps.useMutation();

  const requirementById = new Map(requirementOptions.map((r) => [r.id, r]));

  function submit() {
    const instruction = instructionText.trim();
    if (!instruction || suggest.isPending) return;
    // A fresh conversation (no proposal pending yet) starts from whatever's in the
    // editor right now - re-pin the baseline here rather than only at mount, since the
    // panel (and this state) stays mounted across edits made before the first message.
    const activeBaseline = pendingProposal ? baseline : steps;
    if (!pendingProposal) setBaseline(activeBaseline);
    setError(null);
    const nextMessages: ChatMessage[] = [...messages, { role: "user", content: instruction }];
    setMessages(nextMessages);
    setInstructionText("");
    suggest.mutate(
      {
        productId,
        testCaseTitle,
        originalSteps: activeBaseline.map((s) => ({
          key: s.key,
          description: s.description,
          expectedResult: s.expectedResult,
          purpose: s.purpose,
          // A step can end up carrying a hallucinated requirementId from an earlier
          // accept (see testCases.suggestSteps for the server-side fix at the source) -
          // filtered here too so an already-corrupted step doesn't fail this request's
          // own uuid validation.
          requirementIds: filterKnownRequirementIds(s.requirementIds, requirementById),
        })),
        previousProposal: pendingProposal ?? undefined,
        history: messages,
        instruction,
      },
      {
        onSuccess: (result) => {
          if ("error" in result && result.error) {
            setError(result.error);
            return;
          }
          if (!("upserts" in result)) return;
          // The response is a delta (only what changed) - merged against the resulting
          // list from before this turn so diffProposedSteps/acceptProposal below still
          // just work with a complete list.
          const currentList = pendingProposal ?? stepDraftsToProposedSteps(activeBaseline);
          setPendingProposal(
            applyStepDelta(currentList, { upserts: result.upserts, removedKeys: result.removedKeys, order: result.order }),
          );
          setTruncatedNote(Boolean(result.truncatedRequirements));
          setMessages([...nextMessages, { role: "assistant", content: result.summary }]);
        },
        onError: (err) => setError(err.message),
      },
    );
  }

  function discard() {
    setMessages([]);
    setPendingProposal(null);
    setError(null);
  }

  function acceptAndReset() {
    if (!pendingProposal) return;
    // Same filter as submit() above, so a bad id doesn't reach the real editor state
    // and fail testCases.update's own uuid validation on Save.
    const cleanedProposal = pendingProposal.map((p) => ({
      ...p,
      requirementIds: filterKnownRequirementIds(p.requirementIds, requirementById),
    }));
    onAccept(acceptProposal(baseline, cleanedProposal));
    // Ready for a new conversation, starting from what was just accepted - not the same
    // stale baseline the just-finished one used.
    setMessages([]);
    setPendingProposal(null);
    setError(null);
  }

  const diffRows = pendingProposal ? diffProposedSteps(baseline, pendingProposal) : [];

  return (
    <div className="space-y-3">
      {truncatedNote && (
        <p className="text-xs text-muted-foreground">
          This product has more requirements than could be given to the assistant - only the first few
          hundred were included as context.
        </p>
      )}

      {messages.length > 0 && (
        <div className="max-h-32 space-y-1.5 overflow-y-auto rounded-md border p-2 text-sm">
          {messages.map((m, i) => (
            <p key={i} className={m.role === "user" ? "font-medium text-foreground" : "text-muted-foreground"}>
              {m.role === "user" ? "You: " : "AI: "}
              {m.content}
            </p>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-2">
        <Textarea
          value={instructionText}
          onChange={(e) => setInstructionText(e.target.value)}
          placeholder={
            pendingProposal
              ? "Refine - e.g. 'also cover REQ-42' or 'merge steps 2 and 3'"
              : "Tell it what to do - e.g. 'draft steps covering the new alarm-silence requirement'"
          }
          rows={2}
          className="text-sm"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <Button type="button" size="sm" onClick={submit} disabled={suggest.isPending || !instructionText.trim()} className="self-end">
          {suggest.isPending ? "Thinking..." : pendingProposal ? "Refine" : "Draft"}
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {pendingProposal && (
        <div className="space-y-2">
          <div className="divide-y rounded-md border">
            {diffRows.map((row, i) => (
              <DiffRowView key={i} row={row} requirementById={requirementById} />
            ))}
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={discard}>
              Discard
            </Button>
            <Button type="button" size="sm" onClick={acceptAndReset}>
              Accept
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** "Step N" using the resulting position (where it'll actually end up, post-merge) for
 * anything still present; "was step N" for a removed row, which has no resulting
 * position. Also flags when a kept step's position moved (the AI reordered it, not just
 * edited its content) - otherwise there'd be no visible sign of that in the diff at all,
 * only in where the row happens to sit in the list. */
function stepNumberLabel(row: StepDiffRow): string {
  if (row.action === "removed") return `Was step ${row.originalPosition ?? "?"}`;
  const moved = row.originalPosition !== undefined && row.originalPosition !== row.position;
  return moved ? `Step ${row.position} (was ${row.originalPosition})` : `Step ${row.position}`;
}

function DiffRowView({
  row,
  requirementById,
}: {
  row: StepDiffRow;
  requirementById: Map<string, RequirementOption>;
}) {
  const step = row.proposed ?? row.baseline;
  if (!step) return null;
  const { requirementIds } = step;
  const purposeChanged = row.action === "modified" && (row.baseline?.purpose ?? "") !== (row.proposed?.purpose ?? "");

  return (
    <div className="space-y-1.5 p-2">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">{stepNumberLabel(row)}</span>
        <Badge variant={ACTION_VARIANT[row.action]}>{ACTION_LABEL[row.action]}</Badge>
      </div>

      {row.action === "modified" && row.baseline && row.proposed ? (
        <ModifiedStepDiff before={row.baseline} after={row.proposed} />
      ) : row.action === "removed" ? (
        <StepSide description={step.description} expectedResult={step.expectedResult} struck />
      ) : (
        <StepSide description={step.description} expectedResult={step.expectedResult} />
      )}

      {row.action === "modified" && row.baseline && row.proposed
        ? purposeChanged && (
            <p className="text-xs text-muted-foreground">
              Purpose: <InlineTextDiff segments={diffPlainText(row.baseline.purpose ?? "", row.proposed.purpose ?? "")} />
            </p>
          )
        : step.purpose && <p className="text-xs text-muted-foreground">Purpose: {step.purpose}</p>}
      {requirementIds.length > 0 && (
        <p className="flex flex-wrap gap-1 text-xs">
          {requirementIds.map((id) => {
            const option = requirementById.get(id);
            return (
              <span key={id} className="rounded bg-muted px-1.5 py-0.5" title={option?.title ?? id}>
                {option ? formatItemId(option.levelCode, option.sequenceNumber) : id}
              </span>
            );
          })}
        </p>
      )}
    </div>
  );
}

/** A git-style inline diff for a "modified" row: one line per field, mixing
 * unchanged/removed/added text inline instead of showing the whole field twice. */
function ModifiedStepDiff({ before, after }: { before: StepDraft; after: ProposedStep }) {
  return (
    <div className="space-y-0.5">
      <div className="text-sm">
        <InlineTextDiff segments={diffHtmlFieldsAsText(before.description, after.description)} />
      </div>
      <div className="text-xs text-muted-foreground">
        Expected: <InlineTextDiff segments={diffHtmlFieldsAsText(before.expectedResult, after.expectedResult)} />
      </div>
    </div>
  );
}

/** Renders a diffHtmlFieldsAsText/diffPlainText result inline, character by character -
 * same `<ins>`/`<del>` convention as version-diff.tsx's redline, just finer-grained. */
function InlineTextDiff({ segments }: { segments: TextDiffSegment[] }) {
  return (
    <>
      {segments.map((seg, i) =>
        seg.type === "added" ? (
          <ins key={i} className="rounded-sm bg-emerald-100 px-0.5 text-emerald-800 no-underline">
            {seg.text}
          </ins>
        ) : seg.type === "removed" ? (
          <del key={i} className="rounded-sm bg-red-100 px-0.5 text-red-800">
            {seg.text}
          </del>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  );
}

/** Used for added/removed/unchanged rows, which have nothing to compare against - just
 * the field as-is, struck through for a "removed" row. */
function StepSide({
  description,
  expectedResult,
  struck,
}: {
  description: string;
  expectedResult: string;
  struck?: boolean;
}) {
  return (
    <div className="space-y-0.5">
      <div className={cn("text-sm", struck && "text-muted-foreground line-through decoration-muted-foreground/50")}>
        <RichTextView html={description} />
      </div>
      <div className={cn("text-xs text-muted-foreground", struck && "line-through decoration-muted-foreground/50")}>
        Expected: <RichTextView html={expectedResult} />
      </div>
    </div>
  );
}
