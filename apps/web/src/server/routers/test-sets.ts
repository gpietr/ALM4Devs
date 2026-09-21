import { db } from "@/lib/db";
import {
  addTestSetItem,
  createTestSet,
  createTestSetRound,
  type CustomFieldValueInput,
  deleteTestSet,
  getTestSet,
  getTestSetRound,
  listTestSetRounds,
  listTestSets,
  removeTestSetItem,
  reorderTestSetItem,
  updateTestSet,
  updateTestSetItem,
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

/** See the identical schema in requirements.ts/test-cases.ts for the full semantics -
 * each router's input schemas stay self-contained rather than a shared import. */
const customFieldValueSchema = z.object({
  fieldId: z.string().uuid(),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
});

export const testSetsRouter = router({
  listByProduct: protectedProcedure.input(z.object({ productId: z.string().uuid() })).query(async ({ ctx, input }) => {
    const tenantId = tenantOf(ctx);
    return withTenant(db, tenantId, (tx) => listTestSets(tx, tenantId, input.productId));
  }),

  get: protectedProcedure.input(z.object({ id: z.string().uuid() })).query(async ({ ctx, input }) => {
    const tenantId = tenantOf(ctx);
    return withTenant(db, tenantId, (tx) => getTestSet(tx, tenantId, input.id)).catch((err) => {
      throw new TRPCError({ code: "NOT_FOUND", message: err instanceof Error ? err.message : undefined });
    });
  }),

  create: protectedProcedure
    .input(
      z.object({
        productId: z.string().uuid(),
        name: z.string().trim().min(1).max(200),
        description: z.string().trim().max(5000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      const userId = userIdOf(ctx);
      return withTenant(db, tenantId, (tx) =>
        createTestSet(tx, {
          tenantId,
          productId: input.productId,
          name: input.name,
          description: input.description,
          createdBy: userId,
        }),
      ).catch(toBadRequest);
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        name: z.string().trim().min(1).max(200),
        description: z.string().trim().max(5000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      return withTenant(db, tenantId, (tx) =>
        updateTestSet(tx, { tenantId, id: input.id, name: input.name, description: input.description }),
      ).catch(toBadRequest);
    }),

  delete: protectedProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    const tenantId = tenantOf(ctx);
    await withTenant(db, tenantId, (tx) => deleteTestSet(tx, tenantId, input.id)).catch(toBadRequest);
    return { ok: true };
  }),

  addItem: protectedProcedure
    .input(
      z.object({
        testSetId: z.string().uuid(),
        testCaseId: z.string().uuid(),
        environmentId: z.string().uuid().optional(),
        customFieldValues: z.array(customFieldValueSchema).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      const userId = userIdOf(ctx);
      return withTenant(db, tenantId, (tx) =>
        addTestSetItem(tx, {
          tenantId,
          testSetId: input.testSetId,
          testCaseId: input.testCaseId,
          environmentId: input.environmentId,
          customFieldValues: input.customFieldValues as CustomFieldValueInput[] | undefined,
          createdBy: userId,
        }),
      ).catch(toBadRequest);
    }),

  updateItem: protectedProcedure
    .input(
      z.object({
        itemId: z.string().uuid(),
        environmentId: z.string().uuid().nullable().optional(),
        customFieldValues: z.array(customFieldValueSchema).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      return withTenant(db, tenantId, (tx) =>
        updateTestSetItem(tx, {
          tenantId,
          itemId: input.itemId,
          environmentId: input.environmentId,
          customFieldValues: input.customFieldValues as CustomFieldValueInput[] | undefined,
        }),
      ).catch(toBadRequest);
    }),

  removeItem: protectedProcedure.input(z.object({ itemId: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    const tenantId = tenantOf(ctx);
    await withTenant(db, tenantId, (tx) => removeTestSetItem(tx, tenantId, input.itemId)).catch(toBadRequest);
    return { ok: true };
  }),

  reorderItem: protectedProcedure
    .input(z.object({ testSetId: z.string().uuid(), itemId: z.string().uuid(), direction: z.enum(["up", "down"]) }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      await withTenant(db, tenantId, (tx) =>
        reorderTestSetItem(tx, tenantId, input.testSetId, input.itemId, input.direction),
      ).catch(toBadRequest);
      return { ok: true };
    }),

  startRound: protectedProcedure
    .input(z.object({ testSetId: z.string().uuid(), label: z.string().trim().max(200).optional() }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      const userId = userIdOf(ctx);
      return withTenant(db, tenantId, (tx) =>
        createTestSetRound(tx, { tenantId, testSetId: input.testSetId, label: input.label, startedBy: userId }),
      ).catch(toBadRequest);
    }),

  listRounds: protectedProcedure.input(z.object({ testSetId: z.string().uuid() })).query(async ({ ctx, input }) => {
    const tenantId = tenantOf(ctx);
    return withTenant(db, tenantId, (tx) => listTestSetRounds(tx, tenantId, input.testSetId));
  }),

  getRound: protectedProcedure.input(z.object({ id: z.string().uuid() })).query(async ({ ctx, input }) => {
    const tenantId = tenantOf(ctx);
    return withTenant(db, tenantId, (tx) => getTestSetRound(tx, tenantId, input.id)).catch((err) => {
      throw new TRPCError({ code: "NOT_FOUND", message: err instanceof Error ? err.message : undefined });
    });
  }),
});
