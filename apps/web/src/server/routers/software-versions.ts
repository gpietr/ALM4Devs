import { db } from "@/lib/db";
import { createSoftwareVersion, deleteSoftwareVersion, listSoftwareVersions, updateSoftwareVersion } from "@galm/core";
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

export const softwareVersionsRouter = router({
  listByProduct: protectedProcedure.input(z.object({ productId: z.string().uuid() })).query(async ({ ctx, input }) => {
    const tenantId = tenantOf(ctx);
    return withTenant(db, tenantId, (tx) => listSoftwareVersions(tx, tenantId, input.productId));
  }),

  create: protectedProcedure
    .input(
      z.object({
        productId: z.string().uuid(),
        versionNumber: z.string().trim().min(1).max(100),
        description: z.string().trim().max(5000).optional(),
        releaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      const userId = userIdOf(ctx);
      return withTenant(db, tenantId, (tx) =>
        createSoftwareVersion(tx, {
          tenantId,
          productId: input.productId,
          versionNumber: input.versionNumber,
          description: input.description,
          releaseDate: input.releaseDate ? new Date(input.releaseDate) : undefined,
          createdBy: userId,
        }),
      ).catch(toBadRequest);
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        versionNumber: z.string().trim().min(1).max(100),
        description: z.string().trim().max(5000).optional(),
        releaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      const userId = userIdOf(ctx);
      return withTenant(db, tenantId, (tx) =>
        updateSoftwareVersion(tx, {
          tenantId,
          id: input.id,
          versionNumber: input.versionNumber,
          description: input.description,
          releaseDate: input.releaseDate ? new Date(input.releaseDate) : null,
          editedBy: userId,
        }),
      ).catch(toBadRequest);
    }),

  delete: protectedProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    const tenantId = tenantOf(ctx);
    const userId = userIdOf(ctx);
    await withTenant(db, tenantId, (tx) => deleteSoftwareVersion(tx, { tenantId, id: input.id, deletedBy: userId })).catch(
      toBadRequest,
    );
    return { ok: true };
  }),
});
