import { db } from "@/lib/db";
import { auth } from "@/lib/auth";
import { AccessBlockedError, assertActiveMembership } from "@/server/tenant-access";
import { initTRPC, TRPCError } from "@trpc/server";

export async function createContext(req: Request) {
  const session = await auth.api.getSession({ headers: req.headers });
  return { session };
}

type Context = Awaited<ReturnType<typeof createContext>>;

const t = initTRPC.context<Context>().create();

export const router = t.router;
export const publicProcedure = t.procedure;

/** Requires a logged-in session whose membership is still active (not removed, tenant not
 * suspended - see tenant-access.ts; skipped for system admins). `ctx.session` is non-null
 * past this point. */
export const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.session) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  const user = ctx.session.user as { tenantId: string; removedAt: Date | null; isSystemAdmin?: boolean };
  if (!user.isSystemAdmin) {
    try {
      await assertActiveMembership(db, user);
    } catch (err) {
      if (err instanceof AccessBlockedError) {
        throw new TRPCError({ code: "FORBIDDEN", message: err.message });
      }
      throw err;
    }
  }
  return next({ ctx: { ...ctx, session: ctx.session } });
});

/** Requires the caller's org role to be "admin" - membership management, invites, etc. */
export const orgAdminProcedure = protectedProcedure.use(({ ctx, next }) => {
  const role = (ctx.session.user as { role?: string }).role;
  if (role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Only organization admins can do this." });
  }
  return next({ ctx });
});

/** Requires the flat, cross-tenant isSystemAdmin flag - see scripts/set-system-admin.ts. */
export const systemAdminProcedure = protectedProcedure.use(({ ctx, next }) => {
  const isSystemAdmin = (ctx.session.user as { isSystemAdmin?: boolean }).isSystemAdmin;
  if (!isSystemAdmin) {
    throw new TRPCError({ code: "FORBIDDEN", message: "System admin access required." });
  }
  return next({ ctx });
});
