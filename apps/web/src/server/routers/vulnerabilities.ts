import { db } from "@/lib/db";
import {
  getNvdConnection,
  getOtsSummaryForProduct,
  getVulnerabilitiesForNode,
  recordArchitectureNodeVersion,
  saveNvdConnection,
  setVulnerabilityAnnotation,
} from "@galm/core";
import { withTenant } from "@galm/db";
import { createNvdClient, type NvdClient, scanArchitectureNode } from "@galm/integrations-nvd";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "../trpc";

function tenantOf(ctx: { session: { user: unknown } }): string {
  return (ctx.session.user as { tenantId: string }).tenantId;
}
function userIdOf(ctx: { session: { user: unknown } }): string {
  return (ctx.session.user as { id: string }).id;
}

function toBadRequest(err: unknown): never {
  throw new TRPCError({ code: "BAD_REQUEST", message: err instanceof Error ? err.message : "request failed" });
}

// NVD's own rate limits: 5 requests/30s unauthenticated, 50/30s with an API key. Kept
// server-side (not hardcoded in the frontend) so the throttle used by the "Scan all"
// bulk loop stays in one place if NVD's limits ever change.
const THROTTLE_MS_WITHOUT_KEY = 6_500;
const THROTTLE_MS_WITH_KEY = 700;

async function buildNvdClient(tenantId: string): Promise<NvdClient> {
  const connection = await withTenant(db, tenantId, (tx) => getNvdConnection(tx, tenantId));
  return createNvdClient({ apiKey: connection?.apiKey ?? undefined });
}

export const vulnerabilitiesRouter = router({
  getConnection: protectedProcedure.query(async ({ ctx }) => {
    const tenantId = tenantOf(ctx);
    const connection = await withTenant(db, tenantId, (tx) => getNvdConnection(tx, tenantId));
    const hasApiKey = !!connection?.apiKey;
    return { hasApiKey, suggestedThrottleMs: hasApiKey ? THROTTLE_MS_WITH_KEY : THROTTLE_MS_WITHOUT_KEY };
  }),

  saveConnection: protectedProcedure
    .input(z.object({ apiKey: z.string().trim().max(500).nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      await withTenant(db, tenantId, (tx) => saveNvdConnection(tx, tenantId, input)).catch(toBadRequest);
      return { ok: true };
    }),

  testConnection: protectedProcedure.mutation(async ({ ctx }) => {
    const tenantId = tenantOf(ctx);
    const client = await buildNvdClient(tenantId);
    try {
      return await client.ping();
    } catch (err) {
      throw new TRPCError({ code: "BAD_REQUEST", message: err instanceof Error ? err.message : "connection failed" });
    }
  }),

  searchCpe: protectedProcedure
    .input(z.object({ keyword: z.string().trim().min(1).max(300) }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      const client = await buildNvdClient(tenantId);
      try {
        return await client.searchCpeCandidates(input.keyword);
      } catch (err) {
        throw new TRPCError({ code: "BAD_REQUEST", message: err instanceof Error ? err.message : "CPE search failed" });
      }
    }),

  recordVersion: protectedProcedure
    .input(
      z.object({
        nodeId: z.string().uuid(),
        version: z.string().trim().min(1).max(100),
        cpe: z.string().trim().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      const userId = userIdOf(ctx);
      return withTenant(db, tenantId, (tx) =>
        recordArchitectureNodeVersion(tx, {
          tenantId,
          architectureNodeId: input.nodeId,
          version: input.version,
          cpe: input.cpe,
          createdBy: userId,
        }),
      ).catch(toBadRequest);
    }),

  scanNode: protectedProcedure
    .input(z.object({ nodeId: z.string().uuid(), versionId: z.string().uuid().optional() }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      const userId = userIdOf(ctx);
      const client = await buildNvdClient(tenantId);
      return withTenant(db, tenantId, (tx) =>
        scanArchitectureNode(tx, client, {
          tenantId,
          nodeId: input.nodeId,
          versionId: input.versionId,
          triggeredBy: userId,
        }),
      ).catch(toBadRequest);
    }),

  listForNode: protectedProcedure.input(z.object({ nodeId: z.string().uuid() })).query(async ({ ctx, input }) => {
    const tenantId = tenantOf(ctx);
    return withTenant(db, tenantId, (tx) => getVulnerabilitiesForNode(tx, tenantId, input.nodeId)).catch(toBadRequest);
  }),

  annotate: protectedProcedure
    .input(
      z.object({
        nodeId: z.string().uuid(),
        cveId: z.string().min(1).max(50),
        assessed: z.boolean(),
        affectsProduct: z.boolean(),
        falsePositive: z.boolean(),
        rationale: z.string().trim().max(5000).default(""),
        notes: z.string().trim().max(5000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      const userId = userIdOf(ctx);
      await withTenant(db, tenantId, (tx) =>
        setVulnerabilityAnnotation(tx, {
          tenantId,
          architectureNodeId: input.nodeId,
          cveId: input.cveId,
          assessed: input.assessed,
          affectsProduct: input.affectsProduct,
          falsePositive: input.falsePositive,
          rationale: input.rationale,
          notes: input.notes,
          annotatedBy: userId,
        }),
      ).catch(toBadRequest);
      return { ok: true };
    }),

  otsSummary: protectedProcedure
    .input(z.object({ productId: z.string().uuid(), levelId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      return withTenant(db, tenantId, (tx) => getOtsSummaryForProduct(tx, tenantId, input.productId, input.levelId));
    }),
});
