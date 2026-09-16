import { initTRPC, TRPCError } from "@trpc/server";
import { auth } from "@/lib/auth";

export async function createContext(req: Request) {
  const session = await auth.api.getSession({ headers: req.headers });
  return { session };
}

type Context = Awaited<ReturnType<typeof createContext>>;

const t = initTRPC.context<Context>().create();

export const router = t.router;
export const publicProcedure = t.procedure;

/** Requires a logged-in session. `ctx.session` is non-null past this point. */
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.session) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next({ ctx: { ...ctx, session: ctx.session } });
});
