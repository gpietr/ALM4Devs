"use client";

import { RequirementLinkList, type RequirementOption } from "@/components/requirement-picker";
import { RichTextEditor } from "@/components/rich-text-editor";
import { RichTextView } from "@/components/rich-text-view";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { Check, ChevronDown, ChevronUp, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

export interface StepDraft {
  /** Set for a step loaded from the server; absent for one added client-side and not yet
   * saved. updateTestCase uses this to tell "edit in place" from "insert new" apart. */
  id?: string;
  /** Stable React key, since a brand-new step has no `id` yet to key on. */
  key: string;
  description: string;
  expectedResult: string;
  /** Plain text, not rich HTML - see packages/core/src/test-cases.ts's TestStepInput note. */
  purpose: string;
  requirementIds: string[];
}

export function emptyStep(): StepDraft {
  return { key: crypto.randomUUID(), description: "", expectedResult: "", purpose: "", requirementIds: [] };
}

/** A step's `purpose` may still hold simple HTML from before it became a plain-text field
 * (e.g. anything imported from Spira, which keeps producing HTML - see
 * createOrUpdateTestCaseFromImport). Rendered as plain text everywhere now, so strip any
 * leftover markup down to text instead of showing raw tags or risking unescaped HTML. */
function purposeAsPlainText(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|div|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * A tabular step list, one row per step. Reading is lean by design: description and
 * expected result render as plain rendered text (no toolbar, no editor mounted) until a
 * click on the pencil icon opens that one row for editing - loading a rich-text editor
 * (with its toolbar) for every step on every page load was the actual complaint this
 * replaced ("gazillion rich text editors"), not just a look-and-feel issue. A brand-new
 * step opens straight into editing, since there's nothing yet to show in read mode.
 *
 * Purpose is genuinely plain text (not rich HTML like the other two fields), so it's just
 * a lightweight `Textarea` - no toolbar, no separate view/edit state of its own.
 *
 * Reorder is up/down icon buttons (no drag-and-drop library in this app, and arrows are
 * simpler to get right and fully keyboard-reachable). Delete is a trash icon, disabled
 * below one step - a test case needs at least one. Requirement links show as compact id
 * chips directly in the row (see RequirementLinkList) instead of a full-width multi-select
 * so the row stays scannable.
 *
 * Shared between the "new test case" page and the test-case detail page's edit form.
 */
export function TestStepsEditor({
  steps,
  onChange,
  requirementOptions,
}: {
  steps: StepDraft[];
  onChange: (steps: StepDraft[]) => void;
  requirementOptions: RequirementOption[];
}) {
  const [editingKeys, setEditingKeys] = useState<Set<string>>(
    () => new Set(steps.filter((s) => !s.id).map((s) => s.key)),
  );

  function setEditing(key: string, editing: boolean) {
    setEditingKeys((prev) => {
      const next = new Set(prev);
      if (editing) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  function updateStep(index: number, patch: Partial<StepDraft>) {
    onChange(steps.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= steps.length) return;
    const next = [...steps];
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  }

  function remove(index: number) {
    onChange(steps.filter((_, i) => i !== index));
  }

  function addStep() {
    const step = emptyStep();
    onChange([...steps, step]);
    setEditing(step.key, true);
  }

  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-md border">
        <Table className="table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead className="w-8">#</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>Expected result</TableHead>
              <TableHead className="w-40">Links</TableHead>
              <TableHead className="w-32" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {steps.map((step, i) => {
              const editing = editingKeys.has(step.key);
              return (
                <TableRow key={step.key} className="align-top">
                  <TableCell className="pt-3 text-center font-mono text-xs text-muted-foreground">{i + 1}</TableCell>
                  {editing ? (
                    // While editing, Description and Expected result share ONE cell
                    // (colSpan across both their columns) stacked vertically instead of
                    // squeezed side by side into two narrow columns - the compact
                    // toolbar needs real width to lay out in one row without its own
                    // internal horizontal scroll, and two narrow ~1/5-page columns
                    // weren't enough for it. Reading mode (below) keeps them side by
                    // side, since plain rendered text doesn't have that problem.
                    <TableCell colSpan={2} className="max-w-0 overflow-hidden whitespace-normal py-2 align-top">
                      <div className="min-w-0 space-y-3">
                        <div>
                          <label className="mb-1 block text-xs font-medium text-muted-foreground">Description</label>
                          <RichTextEditor
                            compact
                            value={step.description}
                            onChange={(html) => updateStep(i, { description: html })}
                          />
                        </div>
                        <div>
                          <label className="mb-1 block text-xs font-medium text-muted-foreground">Expected result</label>
                          <RichTextEditor
                            compact
                            value={step.expectedResult}
                            onChange={(html) => updateStep(i, { expectedResult: html })}
                          />
                        </div>
                        <div>
                          <label className="mb-1 block text-xs font-medium text-muted-foreground">Purpose (optional)</label>
                          <Textarea
                            rows={2}
                            value={step.purpose}
                            onChange={(e) => updateStep(i, { purpose: e.target.value })}
                            className="text-xs"
                          />
                        </div>
                      </div>
                    </TableCell>
                  ) : (
                    <>
                      <TableCell className="max-w-0 overflow-hidden whitespace-normal py-2 align-top">
                        <div className="min-w-0">
                          <StepPreview html={step.description} />
                        </div>
                      </TableCell>
                      <TableCell className="max-w-0 overflow-hidden whitespace-normal py-2 align-top">
                        <div className="min-w-0">
                          <StepPreview html={step.expectedResult} />
                          {step.purpose && (
                            <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
                              Purpose: {purposeAsPlainText(step.purpose)}
                            </p>
                          )}
                        </div>
                      </TableCell>
                    </>
                  )}
                  <TableCell className="py-2 align-top">
                    <RequirementLinkList
                      options={requirementOptions}
                      value={step.requirementIds}
                      onChange={(requirementIds) => updateStep(i, { requirementIds })}
                    />
                  </TableCell>
                  <TableCell className="py-2">
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setEditing(step.key, !editing)}
                        aria-label={editing ? "Done editing step" : "Edit step"}
                      >
                        {editing ? <Check /> : <Pencil />}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        disabled={i === 0}
                        onClick={() => move(i, -1)}
                        aria-label="Move step up"
                      >
                        <ChevronUp />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        disabled={i === steps.length - 1}
                        onClick={() => move(i, 1)}
                        aria-label="Move step down"
                      >
                        <ChevronDown />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        disabled={steps.length === 1}
                        onClick={() => remove(i)}
                        aria-label="Remove step"
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <Button type="button" variant="outline" size="sm" onClick={addStep} className="gap-1">
        <Plus />
        Add step
      </Button>
    </div>
  );
}

function StepPreview({ html }: { html: string }) {
  if (!html) return <p className="text-sm text-muted-foreground">—</p>;
  return <RichTextView html={html} />;
}
