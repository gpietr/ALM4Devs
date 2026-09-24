import { type TenantTx, schema } from "@galm/db";
import { eq } from "drizzle-orm";
import { DomainError } from "./errors";
import { assertSafeOutboundUrl, normalizeOutboundUrl } from "./outbound-url";

export type LlmProvider = "anthropic" | "openai" | "openai_compatible";

export interface LlmConnectionInput {
  provider: LlmProvider;
  model: string;
  /** Required for 'openai_compatible' (a self-hosted/third-party endpoint has no default
   * to fall back to); ignored for 'anthropic'/'openai', which use their SDK's own
   * default endpoint. */
  baseUrl?: string | null;
  /** Optional on save so the UI can let you update other fields (provider, model, base
   * URL) without re-entering a key you've already saved - omit or send empty to keep the
   * existing one. Same pattern as SpiraConnectionInput's apiKey. */
  apiKey?: string;
}

export interface LlmConnectionRow {
  tenantId: string;
  provider: LlmProvider;
  model: string;
  baseUrl: string | null;
  apiKey: string;
  updatedAt: Date;
}

export async function getLlmConnection(db: TenantTx, tenantId: string): Promise<LlmConnectionRow | null> {
  const [row] = await db.select().from(schema.llmConnections).where(eq(schema.llmConnections.tenantId, tenantId));
  // `provider` is stored as plain text (CHECK-constrained at the DB level, not a typed
  // enum column - see packages/db/migrations-manual/012) - narrow it back to the literal
  // union here, once, rather than at every call site that needs to hand it to
  // resolveModel (@galm/integrations-llm).
  return row ? { ...row, provider: row.provider as LlmProvider } : null;
}

export async function saveLlmConnection(db: TenantTx, tenantId: string, input: LlmConnectionInput) {
  if (input.provider === "openai_compatible" && !input.baseUrl) {
    throw new DomainError("a base URL is required for an OpenAI-compatible provider");
  }
  // 'anthropic'/'openai' ignore baseUrl entirely and call their SDK's own endpoint, so
  // only the custom-endpoint case has a URL worth validating. The one exception is the
  // offline mock provider the e2e suite runs against - `mock://step-suggestions`, gated on
  // ALLOW_MOCK_LLM_PROVIDER, which resolve-model.ts (@galm/integrations-llm) intercepts
  // before any network call happens. The sentinel is spelled out rather than imported:
  // @galm/core deliberately doesn't depend on the integrations packages, and a test-only
  // constant isn't reason enough to change that.
  const isMockProvider =
    process.env.ALLOW_MOCK_LLM_PROVIDER === "1" && input.baseUrl === "mock://step-suggestions";
  const baseUrl =
    input.provider === "openai_compatible" && input.baseUrl
      ? isMockProvider
        ? input.baseUrl
        : assertSafeOutboundUrl(input.baseUrl, "The AI base URL")
      : null;

  const existing = await getLlmConnection(db, tenantId);

  // Same rule as saveSpiraConnection, with one extra way to reach it: switching provider
  // to 'openai_compatible' redirects the saved key to a caller-supplied endpoint just as
  // effectively as editing an existing custom endpoint does, so a change of *either*
  // provider or base URL has to come with the key typed in again.
  if (existing && !input.apiKey) {
    const redirected =
      input.provider !== existing.provider ||
      (baseUrl ?? "") !== normalizeOutboundUrl(existing.baseUrl ?? "");
    if (redirected) {
      throw new DomainError("Re-enter the API key to point this connection at a different provider or base URL.");
    }
  }

  const apiKey = input.apiKey || existing?.apiKey;
  if (!apiKey) {
    throw new DomainError("an API key is required (this connection has never been saved before)");
  }

  const [row] = await db
    .insert(schema.llmConnections)
    .values({
      tenantId,
      provider: input.provider,
      model: input.model,
      baseUrl,
      apiKey,
    })
    .onConflictDoUpdate({
      target: schema.llmConnections.tenantId,
      set: {
        provider: input.provider,
        model: input.model,
        baseUrl,
        apiKey,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!row) throw new DomainError("failed to save AI connection");
  return row;
}
