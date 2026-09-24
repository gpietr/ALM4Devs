import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { AccessBlockedError, assertActiveMembership } from "@/server/tenant-access";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

/**
 * Shared shell for every authenticated screen (everything except /log-in and /register,
 * which sit outside this route group). Previously only the home page bothered to check
 * for a session and redirect - every other page just let a protectedProcedure call fail
 * with UNAUTHORIZED. Centralizing the redirect here means that gap can't recur per-page.
 *
 * This deliberately does NOT render any shared nav chrome itself - the context strip
 * varies too much page to page (product-scoped vs. not, which artifact/level) to live in
 * one static layout slot without threading state through a client Context for little
 * benefit. Each page renders its own TopBar/ProductContextStrip
 * (see @/components/context-strip) as its first element instead.
 */
export default async function AuthenticatedLayout({ children }: { children: ReactNode }) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    redirect("/log-in");
  }

  const user = session.user as { tenantId: string; removedAt: Date | null; isSystemAdmin?: boolean };
  if (!user.isSystemAdmin) {
    // Skipped for system admins - see tenant-access.ts's note on why (avoids a self-lockout
    // of the admin console if their own tenant/membership is ever suspended/removed).
    try {
      await assertActiveMembership(db, user);
    } catch (err) {
      if (err instanceof AccessBlockedError) {
        redirect(`/access-blocked?reason=${err.reason}`);
      }
      throw err;
    }
  }

  return <>{children}</>;
}
