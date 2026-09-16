import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { ProposedStep } from "./step-suggestions";

export interface LlmConnectionConfig {
  provider: "anthropic" | "openai" | "openai_compatible";
  model: string;
  apiKey: string;
  baseUrl?: string | null;
}

export class LlmApiError extends Error {}

/**
 * A real connection can never legitimately have this exact base URL - it's the one and
 * only trigger for the test-only mock branch below, and only fires when BOTH this
 * sentinel matches AND `ALLOW_MOCK_LLM_PROVIDER=1` is set in the environment (see
 * .env.example - dev/CI only, never set in a real deployment). This keeps the mock
 * concept entirely out of the DB CHECK constraint and the settings UI, which only ever
 * offer the three real provider values.
 */
export const MOCK_BASE_URL_SENTINEL = "mock://step-suggestions";

/**
 * Maps a tenant's saved connection to a real, callable AI SDK model - always an explicit
 * resolved instance (`createX(...)(modelId)`), never a bare model-id string handed
 * straight to `generateObject`/`generateText`. That distinction matters beyond style: a
 * bare string routes through `ai`'s built-in Vercel AI Gateway provider, which this
 * project deliberately never wants to touch (self-hosters bring their own provider key
 * directly, not a Vercel account) - see the e2e test asserting only the intended
 * provider (or the mock, below) is ever reached.
 */
export function resolveModel(config: LlmConnectionConfig): LanguageModel | Promise<LanguageModel> {
  if (process.env.ALLOW_MOCK_LLM_PROVIDER === "1" && config.baseUrl === MOCK_BASE_URL_SENTINEL) {
    return buildMockModel();
  }
  switch (config.provider) {
    case "anthropic":
      return createAnthropic({ apiKey: config.apiKey })(config.model);
    case "openai":
      return createOpenAI({ apiKey: config.apiKey })(config.model);
    case "openai_compatible":
      if (!config.baseUrl) throw new LlmApiError("this connection is missing a base URL");
      return createOpenAICompatible({ name: "custom", apiKey: config.apiKey, baseURL: config.baseUrl })(config.model);
    default: {
      const exhaustive: never = config.provider;
      throw new LlmApiError(`unknown AI provider: ${exhaustive}`);
    }
  }
}

/**
 * Test-only fake model, built via `ai/test`'s own `MockLanguageModelV4` - imported
 * lazily (`await import("ai/test")` only inside this function, never at module top
 * level) so a real request path never even loads it.
 *
 * Content-aware: the incoming prompt is inspected for sentinel substrings (see each
 * branch below) so tests can drive a specific response shape without a real model. Not
 * trying to be a good AI - it's exercising the real request -> response -> merge -> diff
 * shape end to end, nothing more. Branches are mutually exclusive, one delta operation
 * each, and the fallback just adds one step and touches nothing else - a step the
 * response doesn't mention simply isn't regenerated (see stepSuggestionResultSchema's
 * docstring), so "unchanged" needs no dedicated branch of its own.
 */
async function buildMockModel(): Promise<LanguageModel> {
  const { MockLanguageModelV4 } = await import("ai/test");
  return new MockLanguageModelV4({
    provider: "mock",
    modelId: "mock-step-suggestions",
    doGenerate: async (options: { prompt: unknown }) => {
      const promptText = JSON.stringify(options.prompt);
      if (promptText.includes("__mock_force_error__")) {
        throw new LlmApiError("mock provider: forced failure for testing");
      }
      const removeStep = promptText.includes("__mock_remove_step__");
      const modifyStep = promptText.includes("__mock_modify_step__");
      const insertMiddle = promptText.includes("__mock_insert_middle__");
      const hallucinateRequirement = promptText.includes("__mock_hallucinate_requirement__");
      const typoFix = promptText.includes("__mock_typo_fix__");

      // The system prompt embeds each original/previously-proposed step as "- key <key>:
      // <description> -> <expectedResult>" (see buildSystemPrompt in step-suggestions.ts)
      // - JSON.stringify turns a real newline into the two literal characters \n, which
      // \\n below matches. Parsed back out, not hardcoded fake keys, since those could
      // never match a real baseline step's real key. Deduped, first occurrence kept, in
      // case both the "current steps" and "previous proposal" sections repeat a key.
      const allStepKeys = [...promptText.matchAll(/- key (\S+): (?:.*?) -> (?:.*?)\\n/g)].map((m) => m[1] as string);
      const stepKeys = [...new Set(allStepKeys)];
      const firstStepKey = stepKeys[0];
      // Same line, but with the description captured too - only needed for the
      // typo-fix branch below, which edits real content by a small amount rather than
      // swapping it wholesale (the only way to exercise a real, meaningfully-small
      // character-level diff instead of one big removed+added chunk).
      const firstStepLine = promptText.match(/- key (\S+): (.*?) -> (?:.*?)\\n/);

      const upserts: ProposedStep[] = [];
      const removedKeys: string[] = [];
      let order: (string | null)[] | undefined;
      if (typoFix && firstStepKey && firstStepLine) {
        // Appends a small suffix rather than swapping the description wholesale, so the
        // diff shown is a real small character-level change, not one big removed+added
        // chunk. expectedResult is echoed back unchanged.
        const expectedResultMatch = promptText.match(/- key (?:\S+): (?:.*?) -> (.*?)\\n/);
        upserts.push({
          key: firstStepKey,
          description: `${firstStepLine[2]} (reviewed)`,
          expectedResult: expectedResultMatch?.[1] ?? "<p>OK</p>",
          purpose: null,
          requirementIds: [],
        });
      } else if (modifyStep && firstStepKey) {
        upserts.push({
          key: firstStepKey,
          description: "<p>Mock-modified step</p>",
          expectedResult: "<p>Mock-modified expected result</p>",
          purpose: null,
          requirementIds: [],
        });
      } else if (removeStep && firstStepKey) {
        removedKeys.push(firstStepKey);
      } else if (insertMiddle && firstStepKey) {
        upserts.push({ key: null, description: "<p>Mock-inserted-middle step</p>", expectedResult: "<p>OK</p>", purpose: null, requirementIds: [] });
        // Positions the new step right after the first existing one, then every other
        // existing step in order - a complete reordering, not a partial one relying on
        // applyStepDelta's "leftover steps append at the end" fallback.
        order = [firstStepKey, null, ...stepKeys.slice(1)];
      } else if (hallucinateRequirement) {
        // A "bad model" simulation: a requirementId that isn't one of the real ones it
        // was actually given. The server-side filter in testCases.suggestSteps must
        // strip this before it ever reaches the client.
        upserts.push({
          key: null,
          description: "<p>Step covering a hallucinated requirement</p>",
          expectedResult: "<p>OK</p>",
          purpose: null,
          requirementIds: ["00000000-0000-0000-0000-000000000000"],
        });
      } else {
        upserts.push({ key: null, description: "<p>Mock-added step</p>", expectedResult: "<p>OK</p>", purpose: null, requirementIds: [] });
      }
      const object = { summary: "Mock proposal for testing.", upserts, removedKeys, order };
      return {
        content: [{ type: "text", text: JSON.stringify(object) }],
        finishReason: { unified: "stop", raw: undefined },
        usage: {
          inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 0, text: 0, reasoning: 0 },
        },
        warnings: [],
      };
    },
  }) as unknown as LanguageModel;
}
