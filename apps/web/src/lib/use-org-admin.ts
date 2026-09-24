"use client";

import { authClient } from "@/lib/auth-client";

/**
 * Whether the signed-in user is an admin of their organization.
 *
 * Purely for presentation - deciding whether to render a form as editable or read-only.
 * The actual authorization is orgAdminProcedure server-side (apps/web/src/server/trpc.ts);
 * `role` is readable off the session here only because it's an additionalField, and a
 * client can of course lie about what it renders. Never gate anything that matters on this.
 */
export function useIsOrgAdmin(): boolean {
  const session = authClient.useSession();
  return (session.data?.user as { role?: string } | undefined)?.role === "admin";
}
