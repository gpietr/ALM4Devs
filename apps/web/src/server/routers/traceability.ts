import { db } from "@/lib/db";
import { getTraceabilityMatrix } from "@galm/core";
import { withTenant } from "@galm/db";
import { z } from "zod";
import { protectedProcedure, router } from "../trpc";

function tenantOf(ctx: { session: { user: unknown } }): string {
  return (ctx.session.user as { tenantId: string }).tenantId;
}

export const traceabilityRouter = router({
  getMatrix: protectedProcedure.input(z.object({ productId: z.string().uuid() })).query(async ({ ctx, input }) => {
    const tenantId = tenantOf(ctx);
    return withTenant(db, tenantId, (tx) => getTraceabilityMatrix(tx, tenantId, input.productId));
  }),
});
