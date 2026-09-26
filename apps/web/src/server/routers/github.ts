import { db } from "@/lib/db";
import { getGithubConnection, saveGithubConnection } from "@galm/core";
import { withTenant } from "@galm/db";
import { createGithubClient, type GithubClient } from "@galm/integrations-github";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { orgAdminProcedure, protectedProcedure, router } from "../trpc";

function tenantOf(ctx: { session: { user: unknown } }): string {
  return (ctx.session.user as { tenantId: string }).tenantId;
}

export async function buildGithubClient(tenantId: string): Promise<GithubClient> {
  const connection = await withTenant(db, tenantId, (tx) => getGithubConnection(tx, tenantId));
  return createGithubClient({ token: connection?.token ?? undefined });
}

export const githubRouter = router({
  getConnection: protectedProcedure.query(async ({ ctx }) => {
    const tenantId = tenantOf(ctx);
    const connection = await withTenant(db, tenantId, (tx) => getGithubConnection(tx, tenantId));
    return { hasToken: !!connection?.token };
  }),

  saveConnection: orgAdminProcedure
    .input(z.object({ token: z.string().trim().max(500).nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      await withTenant(db, tenantId, (tx) => saveGithubConnection(tx, tenantId, input)).catch((err) => {
        throw new TRPCError({ code: "BAD_REQUEST", message: err instanceof Error ? err.message : "request failed" });
      });
      return { ok: true };
    }),

  testConnection: orgAdminProcedure.mutation(async ({ ctx }) => {
    const client = await buildGithubClient(tenantOf(ctx));
    try {
      return await client.ping();
    } catch (err) {
      throw new TRPCError({ code: "BAD_REQUEST", message: err instanceof Error ? err.message : "connection failed" });
    }
  }),
});
