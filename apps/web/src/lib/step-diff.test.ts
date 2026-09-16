import { describe, expect, test } from "bun:test";
import {
  acceptProposal,
  applyStepDelta,
  diffProposedSteps,
  filterKnownRequirementIds,
  stepDraftsToProposedSteps,
  type ProposedStep,
  type StepDiffAction,
} from "./step-diff";
import type { StepDraft } from "@/components/test-steps-editor";

/**
 * The first frontend unit test in this project - `step-diff.ts` was deliberately kept
 * small, pure, and dependency-free specifically so it would be trivial to test the day
 * this project had a runner for exactly this (see BACKLOG.md item 9.39). That day is
 * this bug: "the diff shows some steps as modified, when they haven't changed at all" -
 * a real, user-reported false positive, not a hypothetical. No new dependency needed -
 * Bun ships its own test runner, the same one tests/e2e.test.ts already uses.
 *
 * Not wired into `bun run typecheck`/`test:e2e` (those stay HTTP/DB-focused) - run
 * directly with `cd apps/web && bun test src/lib/step-diff.test.ts`.
 */

function baselineStep(overrides: Partial<StepDraft> = {}): StepDraft {
  return {
    key: "step-1",
    description: "<p>Enter valid credentials</p>",
    expectedResult: "<p>Login succeeds</p>",
    purpose: "",
    requirementIds: [],
    ...overrides,
  };
}

function proposedStep(overrides: Partial<ProposedStep> = {}): ProposedStep {
  return {
    key: "step-1",
    description: "<p>Enter valid credentials</p>",
    expectedResult: "<p>Login succeeds</p>",
    purpose: null,
    requirementIds: [],
    ...overrides,
  };
}

describe("diffProposedSteps - false-positive 'modified' regression coverage", () => {
  test("byte-identical content is unchanged", () => {
    const [row] = diffProposedSteps([baselineStep()], [proposedStep()]);
    expect(row?.action).toBe("unchanged");
  });

  test("a model 'cleaning up' a double space is not a real change", () => {
    const baseline = [baselineStep({ description: "<p>Enter  valid credentials</p>" })];
    const proposed = [proposedStep({ description: "<p>Enter valid credentials</p>" })];
    expect(diffProposedSteps(baseline, proposed)[0]?.action).toBe("unchanged");
  });

  test("&amp; vs a literal & is not a real change", () => {
    const baseline = [baselineStep({ description: "<p>Username &amp; password</p>" })];
    const proposed = [proposedStep({ description: "<p>Username & password</p>" })];
    expect(diffProposedSteps(baseline, proposed)[0]?.action).toBe("unchanged");
  });

  test("<br> vs <br/> is not a real change", () => {
    const baseline = [baselineStep({ description: "<p>Line one<br>Line two</p>" })];
    const proposed = [proposedStep({ description: "<p>Line one<br/>Line two</p>" })];
    expect(diffProposedSteps(baseline, proposed)[0]?.action).toBe("unchanged");
  });

  test("curly vs straight quotes is not a real change", () => {
    const baseline = [baselineStep({ description: "<p>Click “Log in”</p>" })];
    const proposed = [proposedStep({ description: '<p>Click "Log in"</p>' })];
    expect(diffProposedSteps(baseline, proposed)[0]?.action).toBe("unchanged");
  });

  test("whitespace directly between two tags is not a real change", () => {
    const baseline = [baselineStep({ description: "<p>Click <b>Login</b></p>" })];
    const proposed = [proposedStep({ description: "<p>Click <b>Login</b> </p>" })];
    expect(diffProposedSteps(baseline, proposed)[0]?.action).toBe("unchanged");
  });

  test("a newline the model added just inside the wrapping tag is not a real change", () => {
    const baseline = [baselineStep({ description: "<p>Enter password</p>" })];
    const proposed = [proposedStep({ description: "<p>\n  Enter password\n</p>" })];
    expect(diffProposedSteps(baseline, proposed)[0]?.action).toBe("unchanged");
  });

  test("a real word-level content change is still detected", () => {
    const baseline = [baselineStep({ description: "<p>Enter valid credentials</p>" })];
    const proposed = [proposedStep({ description: "<p>Enter your credentials</p>" })];
    expect(diffProposedSteps(baseline, proposed)[0]?.action).toBe("modified");
  });

  test("a real change to expectedResult alone is still detected", () => {
    const baseline = [baselineStep()];
    const proposed = [proposedStep({ expectedResult: "<p>Login fails with an error</p>" })];
    expect(diffProposedSteps(baseline, proposed)[0]?.action).toBe("modified");
  });

  test("normalization never merges two real, differently-worded words together", () => {
    const baseline = [baselineStep({ description: "<p>Click <b>Login</b> now</p>" })];
    const proposed = [proposedStep({ description: "<p>Click <b>Login</b> then</p>" })];
    expect(diffProposedSteps(baseline, proposed)[0]?.action).toBe("modified");
  });

  test("purpose whitespace reformatting alone is not a real change", () => {
    const baseline = [baselineStep({ purpose: "Covers the happy path" })];
    const proposed = [proposedStep({ purpose: "Covers  the happy path" })];
    expect(diffProposedSteps(baseline, proposed)[0]?.action).toBe("unchanged");
  });

  test("a real purpose change is still detected", () => {
    const baseline = [baselineStep({ purpose: "Covers the happy path" })];
    const proposed = [proposedStep({ purpose: "Covers the error path" })];
    expect(diffProposedSteps(baseline, proposed)[0]?.action).toBe("modified");
  });

  test("requirement links in a different order are not a real change", () => {
    const baseline = [baselineStep({ requirementIds: ["a", "b"] })];
    const proposed = [proposedStep({ requirementIds: ["b", "a"] })];
    expect(diffProposedSteps(baseline, proposed)[0]?.action).toBe("unchanged");
  });

  test("an actually-different requirement link is still detected", () => {
    const baseline = [baselineStep({ requirementIds: ["a"] })];
    const proposed = [proposedStep({ requirementIds: ["c"] })];
    expect(diffProposedSteps(baseline, proposed)[0]?.action).toBe("modified");
  });

  test("added/removed/unmatched-key classification still works alongside the new normalization", () => {
    const baseline = [baselineStep({ key: "keep" }), baselineStep({ key: "drop" })];
    const proposed = [proposedStep({ key: "keep" }), proposedStep({ key: null })];
    const rows = diffProposedSteps(baseline, proposed);
    const expected: StepDiffAction[] = ["added", "removed", "unchanged"];
    expect(rows.map((r) => r.action).sort()).toEqual(expected.sort());
  });
});

describe("acceptProposal", () => {
  test("a matched step keeps its real id/key; a brand-new one gets a fresh key", () => {
    const baseline = [{ ...baselineStep({ key: "keep" }), id: "db-id-1" }];
    const proposed = [proposedStep({ key: "keep" }), proposedStep({ key: null, description: "<p>New step</p>" })];
    const result = acceptProposal(baseline, proposed);
    expect(result[0]?.id).toBe("db-id-1");
    expect(result[0]?.key).toBe("keep");
    expect(result[1]?.id).toBeUndefined();
    expect(typeof result[1]?.key).toBe("string");
    expect(result[1]?.key).not.toBe("keep");
  });
});

describe("applyStepDelta - the token-saving redesign (backlog item 9.42)", () => {
  test("a step not mentioned in upserts or removedKeys passes through byte-for-byte untouched", () => {
    const current = [proposedStep({ key: "a" }), proposedStep({ key: "b", description: "<p>Step B</p>" })];
    const merged = applyStepDelta(current, { upserts: [], removedKeys: [] });
    expect(merged).toEqual(current);
  });

  test("an upsert with a matching key replaces that step in place, at the same position", () => {
    const current = [proposedStep({ key: "a" }), proposedStep({ key: "b" }), proposedStep({ key: "c" })];
    const merged = applyStepDelta(current, {
      upserts: [proposedStep({ key: "b", description: "<p>Changed B</p>" })],
      removedKeys: [],
    });
    expect(merged.map((s) => s.key)).toEqual(["a", "b", "c"]);
    expect(merged[1]?.description).toBe("<p>Changed B</p>");
  });

  test("a new upsert (key: null) is appended with a freshly generated, non-null key", () => {
    const current = [proposedStep({ key: "a" })];
    const merged = applyStepDelta(current, {
      upserts: [proposedStep({ key: null, description: "<p>Brand new</p>" })],
      removedKeys: [],
    });
    expect(merged).toHaveLength(2);
    expect(merged[0]?.key).toBe("a");
    expect(typeof merged[1]?.key).toBe("string");
    expect(merged[1]?.key).not.toBeNull();
    expect(merged[1]?.description).toBe("<p>Brand new</p>");
  });

  test("a removed key drops that step and is not also matched by an upsert", () => {
    const current = [proposedStep({ key: "a" }), proposedStep({ key: "b" })];
    const merged = applyStepDelta(current, { upserts: [], removedKeys: ["a"] });
    expect(merged.map((s) => s.key)).toEqual(["b"]);
  });

  test("a real, multi-turn conversation: add a step, then modify the one just added, using the key applyStepDelta assigned it", () => {
    const baseline = [baselineStep({ key: "original" })];
    // Turn 1: the model adds a step (its own key is null - a brand-new step).
    const afterTurn1 = applyStepDelta(stepDraftsToProposedSteps(baseline), {
      upserts: [proposedStep({ key: null, description: "<p>New step</p>" })],
      removedKeys: [],
    });
    const newStepKey = afterTurn1[1]?.key;
    expect(newStepKey).toBeTruthy();
    expect(newStepKey).not.toBe("original");

    // Turn 2: refine "actually reword that new step" - only possible because turn 1
    // gave it a real key immediately rather than waiting for final accept.
    const afterTurn2 = applyStepDelta(afterTurn1, {
      upserts: [proposedStep({ key: newStepKey ?? null, description: "<p>Reworded new step</p>" })],
      removedKeys: [],
    });
    expect(afterTurn2).toHaveLength(2);
    expect(afterTurn2[0]?.key).toBe("original"); // untouched across both turns
    expect(afterTurn2[1]?.key).toBe(newStepKey); // same identity, not a second new step
    expect(afterTurn2[1]?.description).toBe("<p>Reworded new step</p>");
  });

  test("stepDraftsToProposedSteps + applyStepDelta + diffProposedSteps together produce the same diff shape the full-list design used to", () => {
    const baseline = [baselineStep({ key: "keep" }), baselineStep({ key: "drop" })];
    const merged = applyStepDelta(stepDraftsToProposedSteps(baseline), {
      upserts: [proposedStep({ key: null, description: "<p>Added</p>" })],
      removedKeys: ["drop"],
    });
    const rows = diffProposedSteps(baseline, merged);
    const expected: StepDiffAction[] = ["added", "removed", "unchanged"];
    expect(rows.map((r) => r.action).sort()).toEqual(expected.sort());
  });

  describe("order - real positioning, not just appended at the end (backlog item 9.43)", () => {
    test("without `order`, a new step still just appends at the end - the original, still-correct default", () => {
      const current = [proposedStep({ key: "a" }), proposedStep({ key: "b" })];
      const merged = applyStepDelta(current, {
        upserts: [proposedStep({ key: null, description: "<p>New</p>" })],
        removedKeys: [],
      });
      expect(merged.map((s) => s.description)).toEqual([
        proposedStep({ key: "a" }).description,
        proposedStep({ key: "b" }).description,
        "<p>New</p>",
      ]);
    });

    test("with `order`, a new step lands exactly where the null placeholder says - in the middle, not the end", () => {
      const current = [proposedStep({ key: "a" }), proposedStep({ key: "b" }), proposedStep({ key: "c" })];
      const merged = applyStepDelta(current, {
        upserts: [proposedStep({ key: null, description: "<p>Inserted</p>" })],
        removedKeys: [],
        order: ["a", null, "b", "c"],
      });
      expect(merged.map((s) => s.description)).toEqual([
        proposedStep({ key: "a" }).description,
        "<p>Inserted</p>",
        proposedStep({ key: "b" }).description,
        proposedStep({ key: "c" }).description,
      ]);
    });

    test("`order` can also reorder existing steps with no new ones involved", () => {
      const current = [proposedStep({ key: "a" }), proposedStep({ key: "b" }), proposedStep({ key: "c" })];
      const merged = applyStepDelta(current, { upserts: [], removedKeys: [], order: ["c", "a", "b"] });
      expect(merged.map((s) => s.key)).toEqual(["c", "a", "b"]);
    });

    test("an unknown/hallucinated key in `order` is skipped, never crashes", () => {
      const current = [proposedStep({ key: "a" }), proposedStep({ key: "b" })];
      const merged = applyStepDelta(current, { upserts: [], removedKeys: [], order: ["a", "does-not-exist", "b"] });
      expect(merged.map((s) => s.key)).toEqual(["a", "b"]);
    });

    test("a step `order` forgot to mention is appended at the end, never silently dropped", () => {
      const current = [proposedStep({ key: "a" }), proposedStep({ key: "b" }), proposedStep({ key: "c" })];
      // `order` only mentions "b" - "a" and "c" still exist and must not vanish.
      const merged = applyStepDelta(current, { upserts: [], removedKeys: [], order: ["b"] });
      expect(merged.map((s) => s.key).sort()).toEqual(["a", "b", "c"]);
      expect(merged[0]?.key).toBe("b"); // what order DID specify still comes first
    });

    test("order and removedKeys interact correctly - a removed step's key in `order` is simply not found and skipped", () => {
      const current = [proposedStep({ key: "a" }), proposedStep({ key: "b" }), proposedStep({ key: "c" })];
      const merged = applyStepDelta(current, { upserts: [], removedKeys: ["b"], order: ["c", "b", "a"] });
      expect(merged.map((s) => s.key)).toEqual(["c", "a"]);
    });
  });
});

describe("stepNumberLabel-equivalent position tracking in diffProposedSteps (backlog item 9.43)", () => {
  test("position reflects the resulting (post-merge) order, not the baseline order", () => {
    const baseline = [baselineStep({ key: "a" }), baselineStep({ key: "b" }), baselineStep({ key: "c" })];
    // "b" moved to the front.
    const proposed = [proposedStep({ key: "b" }), proposedStep({ key: "a" }), proposedStep({ key: "c" })];
    const rows = diffProposedSteps(baseline, proposed);
    const byKey = new Map(rows.map((r) => [(r.proposed ?? r.baseline)?.key, r]));
    expect(byKey.get("b")?.position).toBe(1);
    expect(byKey.get("b")?.originalPosition).toBe(2);
    expect(byKey.get("a")?.position).toBe(2);
    expect(byKey.get("a")?.originalPosition).toBe(1);
  });

  test("an added step has a position but no originalPosition", () => {
    const baseline = [baselineStep({ key: "a" })];
    const proposed = [proposedStep({ key: "a" }), proposedStep({ key: null, description: "<p>New</p>" })];
    const rows = diffProposedSteps(baseline, proposed);
    const added = rows.find((r) => r.action === "added");
    expect(added?.position).toBe(2);
    expect(added?.originalPosition).toBeUndefined();
  });

  test("a removed step has an originalPosition but no position", () => {
    const baseline = [baselineStep({ key: "a" }), baselineStep({ key: "gone" })];
    const proposed = [proposedStep({ key: "a" })];
    const rows = diffProposedSteps(baseline, proposed);
    const removed = rows.find((r) => r.action === "removed");
    expect(removed?.originalPosition).toBe(2);
    expect(removed?.position).toBeUndefined();
  });
});

describe("filterKnownRequirementIds - a hallucinated id must never reach Save or the next AI request (backlog item 9.44)", () => {
  test("keeps ids present in the valid set, drops ones that aren't", () => {
    const valid = new Set(["real-1", "real-2"]);
    expect(filterKnownRequirementIds(["real-1", "hallucinated", "real-2"], valid)).toEqual(["real-1", "real-2"]);
  });

  test("an empty list stays empty", () => {
    expect(filterKnownRequirementIds([], new Set(["real-1"]))).toEqual([]);
  });

  test("everything gets dropped if none of it is valid", () => {
    expect(filterKnownRequirementIds(["a", "b"], new Set(["c"]))).toEqual([]);
  });

  test("works against a Map's keys too, not just a Set (the panel's requirementById is a Map)", () => {
    const valid = new Map([["real-1", { id: "real-1" }]]);
    expect(filterKnownRequirementIds(["real-1", "fake"], valid)).toEqual(["real-1"]);
  });
});
