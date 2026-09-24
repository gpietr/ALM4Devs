import { db } from "@/lib/db";
import { getLlmConnection, saveLlmConnection } from "@galm/core";
import { withTenant } from "@galm/db";
import { pingModel, resolveModel } from "@galm/integrations-llm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { orgAdminProcedure, protectedProcedure, router } from "../trpc";

function tenantOf(ctx: { session: { user: unknown } }): string {
  return (ctx.session.user as { tenantId: string }).tenantId;
}

function toBadRequest(err: unknown): never {
  throw new TRPCError({ code: "BAD_REQUEST", message: err instanceof Error ? err.message : "request failed" });
}

/**
 * Per-tenant "bring your own AI provider" connection, backing AI-assisted test step
 * drafting (see testCases.suggestSteps). Mirrors spiraImport's
 * getConnection/saveConnection/testConnection shape exactly.
 */
export const llmRouter = router({
  getConnection: protectedProcedure.query(async ({ ctx }) => {
    const tenantId = tenantOf(ctx);
    const connection = await withTenant(db, tenantId, (tx) => getLlmConnection(tx, tenantId));
    if (!connection) return null;
    // Never echo the API key back to the client, even after saving it.
    return {
      provider: connection.provider,
      model: connection.model,
      baseUrl: connection.baseUrl,
      hasApiKey: true,
    };
  }),

  saveConnection: orgAdminProcedure
    .input(
      z.object({
        provider: z.enum(["anthropic", "openai", "openai_compatible"]),
        model: z.string().trim().min(1).max(200),
        baseUrl: z.string().trim().url().optional(),
        apiKey: z.string().trim().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      await withTenant(db, tenantId, (tx) => saveLlmConnection(tx, tenantId, input)).catch(toBadRequest);
      return { ok: true };
    }),

  testConnection: orgAdminProcedure.mutation(async ({ ctx }) => {
    const tenantId = tenantOf(ctx);
    const connection = await withTenant(db, tenantId, (tx) => getLlmConnection(tx, tenantId));
    if (!connection) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "no AI connection saved yet - save one first" });
    }
    try {
      const model = await resolveModel(connection);
      await pingModel(model);
      return { ok: true };
    } catch (err) {
      throw new TRPCError({ code: "BAD_REQUEST", message: err instanceof Error ? err.message : "connection failed" });
    }
  }),
});
