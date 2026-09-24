import { db } from "@/lib/db";
import {
  createInvitation,
  listMembers,
  listPendingInvitations,
  removeMember,
  revokeInvitation,
  updateMemberRole,
  writeAuditLog,
} from "@galm/core";
import { schema, withTenant } from "@galm/db";
import { enqueue } from "@galm/jobs";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { orgAdminProcedure, protectedProcedure, router } from "../trpc";

function tenantOf(ctx: { session: { user: unknown } }): string {
  return (ctx.session.user as { tenantId: string }).tenantId;
}

function toBadRequest(err: unknown): never {
  throw new TRPCError({ code: "BAD_REQUEST", message: err instanceof Error ? err.message : "request failed" });
}

/** Who can access an organization's data is as much a matter of record as what's in it -
 * so membership changes go into the same hash-chained audit_log as every other
 * state-changing mutation. Mirrors admin.ts's auditAsSystemAdmin for the org-admin side;
 * the role/removal writes themselves run on the plain pool (`user` isn't RLS-protected),
 * so the audit row needs its own withTenant. */
function audit(
  ctx: { session: { user: unknown } },
  entry: { action: string; entityType: string; entityId: string; payload?: Record<string, unknown> },
) {
  const { id: actorUserId, tenantId } = ctx.session.user as { id: string; tenantId: string };
  return withTenant(db, tenantId, (tx) => writeAuditLog(tx, { tenantId, actorUserId, ...entry }));
}

export const membersRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const tenantId = tenantOf(ctx);
    return withTenant(db, tenantId, async (tx) => {
      const [members, pendingInvitations] = await Promise.all([
        listMembers(tx, tenantId),
        listPendingInvitations(tx, tenantId),
      ]);
      return { members, pendingInvitations };
    });
  }),

  invite: orgAdminProcedure
    .input(z.object({ email: z.string().trim().email(), role: z.enum(["admin", "member"]) }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      const inviter = ctx.session.user as { id: string; name: string };
      const [tenant] = await db.select({ name: schema.tenants.name }).from(schema.tenants).where(eq(schema.tenants.id, tenantId));

      const invitation = await withTenant(db, tenantId, (tx) =>
        createInvitation(tx, tenantId, { email: input.email, role: input.role, invitedByUserId: inviter.id }),
      ).catch(toBadRequest);

      const url = `${process.env.BETTER_AUTH_URL}/accept-invite?token=${invitation.token}&tenant=${tenantId}`;
      await enqueue("send-invitation-email", {
        to: invitation.email,
        orgName: tenant?.name ?? "your organization",
        inviterName: inviter.name,
        role: invitation.role,
        url,
      });
      // Email and offered role only - never `invitation.token`, which is the credential
      // this whole flow rests on and would then sit in an append-only table forever.
      await audit(ctx, {
        action: "member.invited",
        entityType: "invitation",
        entityId: invitation.id,
        payload: { email: invitation.email, role: invitation.role },
      });
      return { ok: true };
    }),

  revokeInvitation: orgAdminProcedure
    .input(z.object({ invitationId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      const invitation = await withTenant(db, tenantId, (tx) =>
        revokeInvitation(tx, tenantId, input.invitationId),
      ).catch(toBadRequest);
      await audit(ctx, {
        action: "member.invitation_revoked",
        entityType: "invitation",
        entityId: input.invitationId,
        payload: { email: invitation.email },
      });
      return { ok: true };
    }),

  updateRole: orgAdminProcedure
    .input(z.object({ userId: z.string(), role: z.enum(["admin", "member"]) }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      await updateMemberRole(db, tenantId, input.userId, input.role).catch(toBadRequest);
      await audit(ctx, {
        action: "member.role_changed",
        entityType: "user",
        entityId: input.userId,
        payload: { role: input.role },
      });
      return { ok: true };
    }),

  remove: orgAdminProcedure
    .input(z.object({ userId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      const removed = await removeMember(db, tenantId, input.userId).catch(toBadRequest);
      await audit(ctx, {
        action: "member.removed",
        entityType: "user",
        entityId: input.userId,
        payload: { email: removed.email },
      });
      return { ok: true };
    }),
});
