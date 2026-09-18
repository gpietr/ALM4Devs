import { db } from "@/lib/db";
import { ensureDefaultArchitectureLevels } from "@galm/core";
import { schema, withTenant } from "@galm/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { protectedProcedure, router } from "../trpc";

function tenantOf(ctx: { session: { user: unknown } }): string {
  return (ctx.session.user as { tenantId: string }).tenantId;
}

export const productsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const tenantId = tenantOf(ctx);
    return withTenant(db, tenantId, (tx) =>
      tx.select().from(schema.products).where(eq(schema.products.tenantId, tenantId)),
    );
  }),

  create: protectedProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(200),
        description: z.string().trim().max(2000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      const product = await withTenant(db, tenantId, async (tx) => {
        const [created] = await tx
          .insert(schema.products)
          .values({ tenantId, name: input.name, description: input.description ?? null })
          .returning();
        // Test cases are immediately usable on a new product because register seeds
        // "Default". Architecture is the same: SYSARCH/SWARCH must exist before the
        // Architecture tab opens, including for tenants that predate the module.
        await ensureDefaultArchitectureLevels(tx, tenantId);
        return created;
      });
      return product;
    }),
});
