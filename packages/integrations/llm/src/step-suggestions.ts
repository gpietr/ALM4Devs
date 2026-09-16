import { generateObject, generateText } from "ai";
import type { LanguageModel } from "ai";
import { z } from "zod";
import { LlmApiError } from "./resolve-model";

export const proposedStepSchema = z.object({
  key: z
    .string()
    .nullable()
    .describe("The `key` of an existing step this corresponds to; null for a brand-new step."),
  description: z.string(),
  expectedResult: z.string(),
  purpose: z.string().nullable(),
  requirementIds: z.array(z.string()),
});

/**
 * A delta, not a full list - only steps that are new or actually changing (`upserts`)
 * plus the keys of any steps to delete (`removedKeys`). Anything not mentioned in either
 * one stays exactly as it is. Two reasons this replaced an earlier "always return the
 * complete resulting list" design (backlog item 9.42): asking the model to regenerate
 * every untouched step verbatim, every turn, burns a lot of output tokens for no reason
 * once a test case has more than a handful of steps - a one-step edit on a 20-step case
 * used to mean re-emitting all 20; and since an untouched step is now never regenerated
 * at all, it can no longer pick up incidental reformatting drift (a re-encoded `&`, a
 * different self-closing-tag style, reflowed whitespace) that the diff would then have
 * to tell apart from a real edit - the false-positive "modified" bug (backlog item 9.41)
 * becomes structurally impossible for steps the model didn't touch, not just harder to
 * trigger.
 */
export const stepSuggestionResultSchema = z.object({
  summary: z.string().describe("One short paragraph explaining what changed and why."),
  upserts: z
    .array(proposedStepSchema)
    .describe("Only steps that are new or changed. Do not include a step that should stay exactly as it is."),
  removedKeys: z.array(z.string()).describe("Keys of existing steps that should be deleted entirely."),
  order: z
    .array(z.string().nullable())
    .optional()
    .describe(
      "Only when a new step needs to go somewhere other than the end, or existing steps need to be " +
        "reordered: the complete final sequence of step keys. Use each existing step's real key; use " +
        "null as a placeholder for each new step from `upserts`, in the same order those new steps " +
        "appear there. Omit this field entirely otherwise - everything keeps its current position by " +
        "default.",
    ),
});

export type ProposedStep = z.infer<typeof proposedStepSchema>;
export type StepSuggestionResult = z.infer<typeof stepSuggestionResultSchema>;

export interface StepSuggestionRequirement {
  id: string;
  /** Pre-formatted human-readable id (e.g. "SYSREQ-42"), built by the caller via
   * formatItemId - kept as a plain string here so this package doesn't need to know
   * anything about level codes/sequence numbers. */
  itemId: string;
  title: string;
  description: string;
  background: string | null;
}

export interface StepSuggestionStep {
  key: string;
  description: string;
  expectedResult: string;
  purpose: string | null;
  requirementIds: string[];
}

export interface StepSuggestionRequest {
  testCaseTitle?: string;
  requirements: StepSuggestionRequirement[];
  requirementsTruncated: boolean;
  originalSteps: StepSuggestionStep[];
  previousProposal?: ProposedStep[];
  history: Array<{ role: "user" | "assistant"; content: string }>;
  instruction: string;
}

/** Minimal "does this connection actually work" check (backing llm.testConnection) - a
 * thin wrapper around `generateText` so callers (apps/web's tRPC router) never need their
 * own direct dependency on `ai`, matching how nothing outside this package touches the
 * AI SDK directly. */
export async function pingModel(model: LanguageModel): Promise<void> {
  try {
    await generateText({ model, prompt: "Reply with the single word OK." });
  } catch (err) {
    if (err instanceof LlmApiError) throw err;
    throw new LlmApiError(err instanceof Error ? err.message : "connection failed");
  }
}

export async function proposeStepChanges(model: LanguageModel, req: StepSuggestionRequest): Promise<StepSuggestionResult> {
  try {
    const { object } = await generateObject({
      model,
      schema: stepSuggestionResultSchema,
      instructions: buildSystemPrompt(req),
      messages: [
        ...req.history.map((m) => ({ role: m.role, content: m.content })),
        { role: "user" as const, content: req.instruction },
      ],
    });
    return object;
  } catch (err) {
    if (err instanceof LlmApiError) throw err;
    throw new LlmApiError(err instanceof Error ? `AI request failed: ${err.message}` : "AI request failed");
  }
}

function buildSystemPrompt(req: StepSuggestionRequest): string {
  const lines: string[] = [
    "You help draft and revise verification/validation test steps for a medical device " +
      "test case, working from a chat instruction and the product's requirements.",
    "",
    `Test case: ${req.testCaseTitle ?? "(untitled)"}`,
    "",
    "Requirements available for this product:",
  ];
  if (req.requirements.length === 0) {
    lines.push("(none defined yet)");
  } else {
    for (const r of req.requirements) {
      lines.push(`- ${r.itemId}: ${r.title}`);
      lines.push(`  ${r.description}`);
      if (r.background) lines.push(`  Background: ${r.background}`);
    }
  }
  if (req.requirementsTruncated) {
    lines.push("(only the first requirements are listed above - the full set is larger)");
  }
  lines.push("");
  lines.push("Current steps (this is the baseline unless a previous proposal is given below):");
  if (req.originalSteps.length === 0) {
    lines.push("(none yet)");
  } else {
    for (const s of req.originalSteps) {
      lines.push(`- key ${s.key}: ${s.description} -> ${s.expectedResult}${s.purpose ? ` (purpose: ${s.purpose})` : ""}`);
      if (s.requirementIds.length > 0) lines.push(`  covers requirement ids: ${s.requirementIds.join(", ")}`);
    }
  }
  if (req.previousProposal && req.previousProposal.length > 0) {
    lines.push("");
    lines.push("A previous proposal was already made in this conversation - treat it, not the " + "steps above, as your starting point unless the user's new instruction says otherwise:");
    for (const s of req.previousProposal) {
      lines.push(`- key ${s.key ?? "(new)"}: ${s.description} -> ${s.expectedResult}${s.purpose ? ` (purpose: ${s.purpose})` : ""}`);
    }
  }
  lines.push("");
  lines.push(
    "Only include a step in `upserts` if it's NEW or you're actually changing its content - " +
      "do not re-list a step that should stay exactly as it is; anything not mentioned in " +
      "`upserts` or `removedKeys` automatically stays exactly as it currently is, in its " +
      "current position. For a step you're changing, keep its same `key` in `upserts` and " +
      "give its new content. For a brand-new step, add it to `upserts` with `key` set to " +
      "null. For a step that should be deleted entirely, put its key in `removedKeys` - do " +
      "not also list it in `upserts`. A new step defaults to the end of the list - if it " +
      "should instead go somewhere specific (e.g. \"add a step after step 2\", or the user " +
      "asks to reorder existing steps), you MUST also include `order`: every step's key, in " +
      "the exact final sequence, with a null placeholder at the position of each new step " +
      "(matched in order to the new entries in `upserts`) - do not just add the new step to " +
      "`upserts` and assume that positions it correctly, `upserts`/`removedKeys` alone never " +
      "change step order. `description`/`expectedResult` may use simple HTML (<p>, <strong>, " +
      "<ul>/<li>); `purpose` is plain text only. Only reference requirement ids from the " +
      "list above.",
  );
  return lines.join("\n");
}
