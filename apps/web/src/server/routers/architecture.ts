import { db } from "@/lib/db";
import {
  ARCHITECTURE_KINDS,
  createArchitectureNode,
  deleteArchitectureNode,
  getArchitectureNode,
  getArchitectureNodeVersion,
  listAllByProduct,
  listArchitectureLevels,
  listArchitectureTrace,
  listSoftwareVersionsForEntity,
  listTree,
  replaceSoftwareVersionLinks,
  updateArchitectureNode,
} from "@galm/core";
import { withTenant } from "@galm/db";
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

const kindSchema = z.enum(ARCHITECTURE_KINDS);

export const architectureRouter = router({
  listLevels: protectedProcedure.query(async ({ ctx }) => {
    const tenantId = tenantOf(ctx);
    return withTenant(db, tenantId, (tx) => listArchitectureLevels(tx, tenantId));
  }),

  listAllByProduct: protectedProcedure
    .input(z.object({ productId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      return withTenant(db, tenantId, (tx) => listAllByProduct(tx, tenantId, input.productId));
    }),

  listByProduct: protectedProcedure
    .input(z.object({ productId: z.string().uuid(), levelId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      return withTenant(db, tenantId, (tx) => listTree(tx, tenantId, input.productId, input.levelId)).catch(
        toBadRequest,
      );
    }),

  /** Flat list of nodes on a level with linked requirements and test cases - the
   * Architecture tab's Trace view. */
  listTrace: protectedProcedure
    .input(z.object({ productId: z.string().uuid(), levelId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      return withTenant(db, tenantId, (tx) =>
        listArchitectureTrace(tx, tenantId, input.productId, input.levelId),
      ).catch(toBadRequest);
    }),

  get: protectedProcedure.input(z.object({ id: z.string().uuid() })).query(async ({ ctx, input }) => {
    const tenantId = tenantOf(ctx);
    return withTenant(db, tenantId, async (tx) => {
      const result = await getArchitectureNode(tx, tenantId, input.id);
      // Each OTS version's own "applies to which release" tags - a small, per-node list
      // (a handful of versions at most), so a plain per-row lookup rather than a batched
      // join is simplest here.
      const versionHistory = await Promise.all(
        result.versionHistory.map(async (v) => ({
          ...v,
          softwareVersions: await listSoftwareVersionsForEntity(tx, tenantId, "architecture_node_version", v.id),
        })),
      );
      return { ...result, versionHistory };
    }).catch((err) => {
      throw new TRPCError({ code: "NOT_FOUND", message: err instanceof Error ? err.message : undefined });
    });
  }),

  create: protectedProcedure
    .input(
      z.object({
        productId: z.string().uuid(),
        levelId: z.string().uuid(),
        kind: kindSchema,
        parentId: z.string().uuid().optional(),
        title: z.string().trim().min(1).max(300),
        description: z.string().trim().max(20000).optional(),
        supplier: z.string().trim().max(300).optional(),
        version: z.string().trim().max(100).optional(),
        cpe: z.string().trim().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      const userId = userIdOf(ctx);
      return withTenant(db, tenantId, (tx) =>
        createArchitectureNode(tx, {
          tenantId,
          productId: input.productId,
          levelId: input.levelId,
          kind: input.kind,
          parentId: input.parentId ?? null,
          title: input.title,
          description: input.description,
          supplier: input.supplier,
          version: input.version,
          cpe: input.cpe,
          createdBy: userId,
        }),
      ).catch(toBadRequest);
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        title: z.string().trim().min(1).max(300),
        description: z.string().trim().max(20000).optional(),
        parentId: z.string().uuid().nullable().optional(),
        supplier: z.string().trim().max(300).nullable().optional(),
        requirementIds: z.array(z.string().uuid()).optional(),
        testCaseIds: z.array(z.string().uuid()).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      const userId = userIdOf(ctx);
      return withTenant(db, tenantId, (tx) =>
        updateArchitectureNode(tx, {
          tenantId,
          id: input.id,
          title: input.title,
          description: input.description,
          parentId: input.parentId,
          supplier: input.supplier,
          requirementIds: input.requirementIds,
          testCaseIds: input.testCaseIds,
          actorUserId: userId,
        }),
      ).catch(toBadRequest);
    }),

  /** Which software versions (releases) shipped with this exact OTS component version -
   * e.g. "the app shipped with Log4j 2.14.1 in v1.0". Not folded into the node's own
   * `update` since a version row is otherwise immutable (see recordVersion) - this is a
   * separate, editable tag on it. */
  setVersionSoftwareVersions: protectedProcedure
    .input(
      z.object({
        nodeId: z.string().uuid(),
        architectureNodeVersionId: z.string().uuid(),
        softwareVersionIds: z.array(z.string().uuid()),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      return withTenant(db, tenantId, async (tx) => {
        const { node } = await getArchitectureNode(tx, tenantId, input.nodeId);
        await getArchitectureNodeVersion(tx, tenantId, input.nodeId, input.architectureNodeVersionId);
        await replaceSoftwareVersionLinks(tx, {
          tenantId,
          entityType: "architecture_node_version",
          entityId: input.architectureNodeVersionId,
          productId: node.productId,
          softwareVersionIds: input.softwareVersionIds,
        });
        return { ok: true };
      }).catch(toBadRequest);
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      const userId = userIdOf(ctx);
      await withTenant(db, tenantId, (tx) => deleteArchitectureNode(tx, tenantId, input.id, userId)).catch(
        toBadRequest,
      );
      return { ok: true };
    }),
});
