import type { StepDraft } from "@/components/test-steps-editor";

/** Mirrors the shape testCases.suggestSteps returns for each proposed step - declared
 * locally rather than imported from @galm/integrations-llm, since that package pulls in
 * the AI SDK (server/Bun-only), which has no business in a client bundle - same
 * duplicate-the-small-shape convention used elsewhere in this app for exactly this
 * reason (e.g. @galm/documents is never imported client-side either). */
export interface ProposedStep {
  key: string | null;
  description: string;
  expectedResult: string;
  purpose: string | null;
  requirementIds: string[];
}

export type StepDiffAction = "added" | "modified" | "removed" | "unchanged";

export interface StepDiffRow {
  action: StepDiffAction;
  proposed?: ProposedStep;
  baseline?: StepDraft;
  /** 1-based position in the resulting step list (the order the step will actually end
   * up in, post-merge) - present for added/modified/unchanged rows; a removed row has no
   * position in the result, so this is absent there. */
  position?: number;
  /** 1-based position in the ORIGINAL baseline list, before this turn's changes -
   * present for modified/unchanged/removed rows (anything that existed before); absent
   * for a brand-new added row, which has no "original" position. */
  originalPosition?: number;
}

/** A model asked to "copy this step verbatim" essentially never reproduces the exact same
 * bytes, even with nothing actually changed - it might re-encode an `&`, use `<br/>`
 * where the original had `<br>`, straighten a curly quote, or just re-wrap whitespace
 * inside a tag. None of that is a real edit, but a naive string (or whitespace-between-
 * tags-only) comparison flags all of it as "modified" - confirmed for real against a set
 * of exactly these cases before landing on this normalizer, not assumed fixed from
 * reading the regex. Stays plain-string/regex-based (no DOM parsing) so this module keeps
 * its "small, pure, dependency-free" shape - deliberately not a hardened HTML-equivalence
 * check (it doesn't handle attribute reordering, for one), just enough to absorb the
 * reformatting an LLM actually tends to introduce when it isn't changing anything. */
function normalizeHtml(html: string): string {
  return html
    .replace(/<(br|hr|img)\s*\/?>/gi, "<$1>") // <br> / <br/> / <br /> are the same tag
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/[‘’]/g, "'") // curly single quotes -> straight
    .replace(/[“”]/g, '"') // curly double quotes -> straight
    .replace(/\s+/g, " ") // all whitespace, not just between tags, collapses to one space
    .replace(/>\s</g, "><") // ...and whitespace with nothing but two tag boundaries around it is purely structural - drop it entirely, not just collapse it
    .replace(/^(<[a-z][^>]*>)\s/i, "$1") // leading whitespace just inside the outermost opening tag - browsers don't render it either
    .replace(/\s(<\/[a-z]+>)$/i, "$1") // same, trailing whitespace just inside the outermost closing tag
    .trim();
}

/** Same reasoning as normalizeHtml above, for the one plain-text field (`purpose`) -
 * no tags/entities to worry about, just incidental whitespace reformatting. */
function normalizePlainText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function sameRequirementSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((id, i) => id === sortedB[i]);
}

/**
 * Diffs a proposed (already delta-merged, see applyStepDelta below) step list against
 * the fixed baseline the assist dialog opened with - by `key`, the same stable per-step
 * identity TestStepsEditor's own StepDraft already uses, never by array position (a step
 * can move as part of a merge). Computed purely from real content comparison here, never
 * trusted from anything the model claims about its own edit.
 *
 * A proposed step whose `key` doesn't match any baseline key (including a
 * hallucinated/duplicate one) is defensively treated as `added`, never throws.
 */
export function diffProposedSteps(baseline: StepDraft[], proposed: ProposedStep[]): StepDiffRow[] {
  const byKey = new Map(baseline.map((s) => [s.key, s]));
  const originalPositionByKey = new Map(baseline.map((s, i) => [s.key, i + 1]));
  const consumed = new Set<string>();

  const rows: StepDiffRow[] = proposed.map((p, i) => {
    const match = p.key ? byKey.get(p.key) : undefined;
    if (!match || consumed.has(match.key)) {
      return { action: "added", proposed: p, position: i + 1 };
    }
    consumed.add(match.key);
    const changed =
      normalizeHtml(match.description) !== normalizeHtml(p.description) ||
      normalizeHtml(match.expectedResult) !== normalizeHtml(p.expectedResult) ||
      normalizePlainText(match.purpose ?? "") !== normalizePlainText(p.purpose ?? "") ||
      !sameRequirementSet(match.requirementIds, p.requirementIds);
    return {
      action: changed ? "modified" : "unchanged",
      proposed: p,
      baseline: match,
      position: i + 1,
      originalPosition: originalPositionByKey.get(match.key),
    };
  });

  for (const b of baseline) {
    if (!consumed.has(b.key)) rows.push({ action: "removed", baseline: b, originalPosition: originalPositionByKey.get(b.key) });
  }
  return rows;
}

/** Mirrors testCases.suggestSteps's response shape (backlog item 9.42/9.43) - only the
 * steps that are new or actually changing, plus the keys of any steps to delete.
 * Anything not mentioned in either stays exactly as it is, in its current position,
 * unless `order` says otherwise - see applyStepDelta below for how that gets turned into
 * the full list diffProposedSteps needs. */
export interface StepDelta {
  upserts: ProposedStep[];
  removedKeys: string[];
  /** The complete final sequence of step keys, only when repositioning something (a new
   * step inserted somewhere other than the end, or an existing step moved) - omitted for
   * a pure content-only turn. Existing steps by their real key; `null` is a placeholder
   * for each new (`key: null`) entry in `upserts`, matched positionally in the same
   * order those new steps appear there. */
  order?: (string | null)[];
}

/** The editor's own StepDraft[] in ProposedStep shape - the starting "current resulting
 * list" for a fresh conversation's first delta merge (a refinement turn instead starts
 * from whatever the previous merge already produced). */
export function stepDraftsToProposedSteps(steps: StepDraft[]): ProposedStep[] {
  return steps.map((s) => ({
    key: s.key,
    description: s.description,
    expectedResult: s.expectedResult,
    purpose: s.purpose || null,
    requirementIds: s.requirementIds,
  }));
}

/**
 * Merges a delta response into `current` (the resulting list as of just before this
 * turn - the editor's own steps via stepDraftsToProposedSteps for the first message in a
 * conversation, or the previous merge's own return value for a refinement) to produce
 * the new full resulting list - the shape diffProposedSteps/acceptProposal already
 * expect, so neither of those needed to change for this. All the actual LLM-facing
 * token savings live here: the model only ever has to generate what changed, not
 * re-list every step untouched by this turn, and this function does the (free, local)
 * work of reconstructing the full picture.
 *
 * A new step (`key: null` in the delta) is assigned a real key immediately, not deferred
 * until the whole proposal is finally accepted - a later refinement in the same
 * conversation needs to be able to refer back to a step this turn just added, and it can
 * only do that by a real key (this merged list, including that key, is what gets sent
 * back as `previousProposal` on the next request).
 *
 * `order`, when given, decides final position - without it, a new step appends at the
 * end and everything else keeps its current relative order (the original, and still the
 * common-case, behavior). Never trusts `order` blindly: an unknown/hallucinated key is
 * skipped rather than crashing, and any step that should still exist but `order` didn't
 * account for (the model forgot to list it, or gave fewer `null` placeholders than there
 * are actually-new steps) is appended at the end rather than silently dropped.
 */
export function applyStepDelta(current: ProposedStep[], delta: StepDelta): ProposedStep[] {
  const removed = new Set(delta.removedKeys);
  const upsertsByKey = new Map(
    delta.upserts.filter((u): u is ProposedStep & { key: string } => u.key !== null).map((u) => [u.key, u]),
  );
  const newSteps = delta.upserts.filter((u) => u.key === null).map((u) => ({ ...u, key: crypto.randomUUID() }));

  const contentUpdated = current
    .filter((s) => !s.key || !removed.has(s.key))
    .map((s) => (s.key ? (upsertsByKey.get(s.key) ?? s) : s));

  if (!delta.order || delta.order.length === 0) {
    return [...contentUpdated, ...newSteps];
  }

  const byKey = new Map(contentUpdated.filter((s) => s.key).map((s) => [s.key as string, s]));
  const usedKeys = new Set<string>();
  let newStepIndex = 0;
  const ordered: ProposedStep[] = [];
  for (const entry of delta.order) {
    if (entry === null) {
      const step = newSteps[newStepIndex++];
      if (step) {
        ordered.push(step);
        usedKeys.add(step.key as string);
      }
      continue;
    }
    const step = byKey.get(entry);
    if (step && !usedKeys.has(entry)) {
      ordered.push(step);
      usedKeys.add(entry);
    }
  }
  const leftoverExisting = contentUpdated.filter((s) => s.key && !usedKeys.has(s.key));
  const leftoverNew = newSteps.slice(newStepIndex);
  return [...ordered, ...leftoverExisting, ...leftoverNew];
}

/** Turns an accepted proposal back into the editor's own StepDraft[] shape - a matched
 * step keeps its real `id`/`key` (so the editor's own change-tracking sees "edited", not
 * "removed + added"); a brand-new one gets a fresh key via the same crypto.randomUUID()
 * mechanism TestStepsEditor's own emptyStep() uses (not imported from there just for
 * this, since that's the entirety of what it does). */
export function acceptProposal(baseline: StepDraft[], proposal: ProposedStep[]): StepDraft[] {
  const byKey = new Map(baseline.map((s) => [s.key, s]));
  return proposal.map((p) => {
    const match = p.key ? byKey.get(p.key) : undefined;
    return {
      id: match?.id,
      key: match?.key ?? crypto.randomUUID(),
      description: p.description,
      expectedResult: p.expectedResult,
      purpose: p.purpose ?? "",
      requirementIds: p.requirementIds,
    };
  });
}

/**
 * Drops any id not in `validIds` - used wherever a step's `requirementIds` might carry a
 * hallucinated or stale value that isn't one of the product's real requirements
 * (backlog item 9.44: a model can echo/invent a bad id, and it flowing unfiltered into
 * the editor's real state later hard-fails Save or the next AI request, both of which
 * require every requirementId to actually be a real uuid). The server already filters a
 * fresh response's own `upserts` before it ever reaches the client (see
 * testCases.suggestSteps) - this is the client-side twin, applied wherever a step's
 * *existing* requirementIds get read back out for another request or for Save, since a
 * step the AI never touches just passes straight through every merge unmodified and
 * could still be carrying a bad id from before that server-side fix existed.
 */
export function filterKnownRequirementIds(ids: string[], validIds: ReadonlySet<string> | ReadonlyMap<string, unknown>): string[] {
  return ids.filter((id) => validIds.has(id));
}
