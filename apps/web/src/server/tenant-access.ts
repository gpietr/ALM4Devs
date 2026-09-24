import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import type { AppDb } from "@galm/db";
import { schema } from "@galm/db";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

/**
 * Thrown by assertActiveMembership - the reason drives the redirect target
 * ((app)/layout.tsx) or the tRPC error message (trpc.ts's protectedProcedure).
 */
export class AccessBlockedError extends Error {
  constructor(public reason: "removed" | "suspended") {
    super(
      reason === "removed"
        ? "Your access to this organization has been removed."
        : "Your organization's access is currently suspended.",
    );
  }
}

/**
 * Called from all three choke points an authenticated caller can arrive through:
 * protectedProcedure (trpc.ts), (app)/layout.tsx, and requireActiveUser below (the raw
 * route handlers under /api that don't go through tRPC). All three skip this entirely for
 * system admins, so a system admin whose own tenant gets suspended (or who removes
 * themselves as a member) is never locked out of the admin console.
 */
export async function assertActiveMembership(
  db: AppDb,
  user: { tenantId: string; removedAt: Date | null },
): Promise<void> {
  if (user.removedAt) throw new AccessBlockedError("removed");
  const [tenant] = await db.select({ suspended: schema.tenants.suspended }).from(schema.tenants).where(eq(schema.tenants.id, user.tenantId));
  if (tenant?.suspended) throw new AccessBlockedError("suspended");
}

export interface ActiveUser {
  id: string;
  email: string;
  tenantId: string;
  removedAt: Date | null;
  isSystemAdmin?: boolean;
}

/**
 * Route-handler counterpart to trpc.ts's protectedProcedure: session + active-membership
 * in one call, for the handful of endpoints that return binary/redirect responses rather
 * than JSON-RPC and so can't be tRPC procedures (attachments, document generation,
 * storage, reauth).
 *
 * Every one of those previously checked only "is there a session", which meant a removed
 * member - or any member of a suspended tenant - kept full read/write access to their
 * org's attachments and documents even though tRPC and the page shell both turned them
 * away. Returns either the user or the Response to send, so a caller is:
 *
 *     const user = await requireActiveUser(req);
 *     if (user instanceof Response) return user;
 */
export async function requireActiveUser(req: Request): Promise<ActiveUser | Response> {
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const user = session.user as ActiveUser;
  if (!user.tenantId) {
    return NextResponse.json({ error: "no tenant" }, { status: 400 });
  }
  if (!user.isSystemAdmin) {
    try {
      await assertActiveMembership(db, user);
    } catch (err) {
      if (err instanceof AccessBlockedError) {
        return NextResponse.json({ error: err.message }, { status: 403 });
      }
      throw err;
    }
  }
  return user;
}
