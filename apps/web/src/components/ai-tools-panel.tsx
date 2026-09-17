"use client";

import { RichTextView } from "@/components/rich-text-view";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { RequirementOption } from "@/components/requirement-picker";
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
import { useState } from "react";

const ACTION_LABEL: Record<StepDiffAction, string> = {
  added: "ADDED",
  modified: "MODIFIED",
  removed: "REMOVED",
  unchanged: "UNCHANGED",
};
/** Coded by form (fill/outline/dashed), same convention as status-pill.tsx/
 * result-badge.tsx: modified = accent outline, added = ink fill, removed = dashed
 * hairline (an exception state, same visual family as ResultBadge's "blocked"),
 * unchanged never actually renders (see DiffRowView - a row is only ever shown for a
 * real change), kept here only so the map is total. */
const ACTION_CLASS: Record<StepDiffAction, string> = {
  modified: "border border-primary text-accent-tint-foreground",
  added: "bg-foreground text-background",
  removed: "border border-dashed border-foreground/45 text-muted-foreground",
  unchanged: "border border-border text-muted-foreground",
};
/** The same left-bar colors as ACTION_CLASS's border/fill, restated as a plain color for
 * the 3px bar - can't be derived from the class strings above without parsing them. */
const ACTION_BAR_CLASS: Record<StepDiffAction, string> = {
  modified: "border-l-primary",
  added: "border-l-foreground",
  removed: "border-l-foreground/30",
  unchanged: "border-l-border",
};

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * The AI tools rail tab's content - AI-assisted test step drafting, chat: instruction ->
 * proposal -> refine/accept. Lives inside `ContextRail`'s "AI" tab (see
 * design_handoff_shell_restructure/README.md's "2e") rather than a floating overlay of
 * its own the way this used to render; the rail owns which tab is showing, this only
 * renders its content. Renders nothing when no AI connection is configured - same
 * "quietly absent until configured" convention as GenerateDocumentButton.
 */
export function AiStepAssistBody({
  productId,
  testCaseTitle,
  testCaseDisplayId,
  steps,
  requirementOptions,
  onAccept,
}: {
  productId: string;
  testCaseTitle?: string;
  testCaseDisplayId?: string;
  steps: StepDraft[];
  requirementOptions: RequirementOption[];
  onAccept: (steps: StepDraft[]) => void;
}) {
  const connection = trpc.llm.getConnection.useQuery();
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
    // rail (and this state) stays mounted across edits made before the first message.
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

  if (connection.isLoading || !connection.data) return null;

  const diffRows = pendingProposal ? diffProposedSteps(baseline, pendingProposal).filter((r) => r.action !== "unchanged") : [];

  return (
    <div className="space-y-2">
      <p className="font-mono text-[10.5px] tracking-[0.12em] text-muted-foreground uppercase">
        Context · {testCaseDisplayId ?? "—"} · {steps.length} step{steps.length === 1 ? "" : "s"}
      </p>

      {truncatedNote && (
        <p className="text-xs text-muted-foreground">
          This product has more requirements than could be given to the assistant - only the first few
          hundred were included as context.
        </p>
      )}

      {messages.length > 0 && (
        <div className="max-h-[132px] space-y-1.5 overflow-y-auto border border-border bg-card p-2.5 text-[13.5px]">
          {messages.map((m, i) => (
            <p key={i} className={m.role === "user" ? "text-foreground" : "text-muted-foreground"}>
              <span className="font-mono text-[11px] font-medium text-muted-foreground">{m.role === "user" ? "YOU" : "AI"}</span>{" "}
              {m.content}
            </p>
          ))}
        </div>
      )}

      <Textarea
        value={instructionText}
        onChange={(e) => setInstructionText(e.target.value)}
        placeholder={
          pendingProposal
            ? 'Refine — "also cover SYS-7", "merge 02 and 03"…'
            : "Tell it what to do — e.g. \"draft steps covering the new alarm-silence requirement\""
        }
        rows={2}
        className="min-h-[54px] rounded-none border-border bg-card text-[13.5px]"
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="flex items-center justify-between">
        <span className="text-[12.5px] text-muted-foreground">Diffed against the editor, not the last message</span>
        <Button type="button" size="sm" onClick={submit} disabled={suggest.isPending || !instructionText.trim()}>
          {suggest.isPending ? "Thinking…" : pendingProposal ? "Refine" : "Draft"}
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {pendingProposal && (
        <div className="space-y-2.5 pt-2">
          <p className="font-mono text-[10.5px] tracking-[0.12em] text-muted-foreground uppercase">
            Proposed · {diffRows.length} change{diffRows.length === 1 ? "" : "s"}
          </p>
          <div className="divide-y divide-border border border-border bg-card">
            {diffRows.map((row, i) => (
              <DiffRowView key={i} row={row} requirementById={requirementById} />
            ))}
          </div>
          <div className="flex gap-2">
            <Button type="button" onClick={acceptAndReset} className="flex-1">
              Accept {diffRows.length}
            </Button>
            <Button type="button" variant="outline" onClick={discard}>
              Discard
            </Button>
          </div>
          <p className="text-[12.5px] text-muted-foreground">
            Accepting writes into the step editor — still unsaved until <span className="font-mono">⌘S</span>.
          </p>
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
    <div className={cn("space-y-1.5 border-l-[3px] p-2.5", ACTION_BAR_CLASS[row.action])}>
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11.5px] font-medium text-muted-foreground">{stepNumberLabel(row)}</span>
        <span className={cn("px-1.5 font-mono text-[11px] font-medium", ACTION_CLASS[row.action])}>
          {ACTION_LABEL[row.action]}
        </span>
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
            <p className="text-[12.5px] text-muted-foreground">
              Purpose: <InlineTextDiff segments={diffPlainText(row.baseline.purpose ?? "", row.proposed.purpose ?? "")} />
            </p>
          )
        : step.purpose && <p className="text-[12.5px] text-muted-foreground">Purpose: {step.purpose}</p>}
      {requirementIds.length > 0 && (
        <p className="flex flex-wrap gap-1">
          {requirementIds.map((id) => {
            const option = requirementById.get(id);
            return (
              <span
                key={id}
                className="border border-border px-1.5 font-mono text-[11.5px]"
                title={option?.title ?? id}
              >
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
      <div className="text-[13.5px]">
        <InlineTextDiff segments={diffHtmlFieldsAsText(before.description, after.description)} />
      </div>
      <div className="text-[12.5px] text-muted-foreground">
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
          <ins key={i} className="bg-[rgba(89,128,166,.24)] px-0.5 no-underline">
            {seg.text}
          </ins>
        ) : seg.type === "removed" ? (
          <del key={i} className="bg-[rgba(29,31,32,.12)] px-0.5">
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
      <div className={cn("text-[13.5px]", struck && "text-muted-foreground line-through decoration-muted-foreground/50")}>
        <RichTextView html={description} />
      </div>
      <div className={cn("text-[12.5px] text-muted-foreground", struck && "line-through decoration-muted-foreground/50")}>
        Expected: <RichTextView html={expectedResult} />
      </div>
    </div>
  );
}
