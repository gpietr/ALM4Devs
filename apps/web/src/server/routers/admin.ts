import { db } from "@/lib/db";
import { updateMemberRole, writeAuditLog } from "@galm/core";
import { schema, withTenant } from "@galm/db";
import { TRPCError } from "@trpc/server";
import { and, count, desc, eq, exists, ilike, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { router, systemAdminProcedure } from "../trpc";

function toBadRequest(err: unknown): never {
  throw new TRPCError({ code: "BAD_REQUEST", message: err instanceof Error ? err.message : "request failed" });
}

/**
 * These are the most privileged mutations in the product and were the only state-changing
 * ones writing no history at all - which meant the tamper-evident, hash-chained audit_log
 * could show a tenant's own admins being changed while staying silent about a system admin
 * doing the same thing from outside the tenant.
 *
 * Recorded against the *affected* tenant, not the actor's, so it lands in the trail the
 * people who were acted upon can actually see; `actorUserId` names the system admin who
 * did it. audit_log is RLS-protected like every other business table, hence withTenant.
 */
function auditAsSystemAdmin(
  actorUserId: string,
  tenantId: string,
  entry: { action: string; entityType: string; entityId: string; payload?: Record<string, unknown> },
) {
  return withTenant(db, tenantId, (tx) => writeAuditLog(tx, { tenantId, actorUserId, ...entry }));
}

// This dev/test database alone has 10,000+ tenants and users - rendering all of them
// client-side is what caused the reported overflow. Cap results and require search to
// narrow further, rather than building full pagination for a rarely-used admin tool.
const RESULT_LIMIT = 50;

export const adminRouter = router({
  // tenants/user aren't RLS-protected (tenants is the tenant-defining table; user's
  // login-by-email lookup has to work before any tenant is known) - plain db queries,
  // intentionally cross-tenant, no withTenant needed.
  listTenants: systemAdminProcedure
    .input(z.object({ search: z.string().trim().default("") }).default({}))
    .query(async ({ input }) => {
      // A member's email matching is a correlated EXISTS, not the memberCount leftJoin
      // below - keeps "found via a member's email" from affecting the (non-removed-only)
      // member count.
      const memberEmailMatch = db
        .select({ one: sql<number>`1` })
        .from(schema.user)
        .where(and(eq(schema.user.tenantId, schema.tenants.id), ilike(schema.user.email, `%${input.search}%`)));

      return db
        .select({
          id: schema.tenants.id,
          name: schema.tenants.name,
          suspended: schema.tenants.suspended,
          createdAt: schema.tenants.createdAt,
          memberCount: count(schema.user.id),
        })
        .from(schema.tenants)
        .leftJoin(schema.user, and(eq(schema.user.tenantId, schema.tenants.id), isNull(schema.user.removedAt)))
        .where(
          input.search ? or(ilike(schema.tenants.name, `%${input.search}%`), exists(memberEmailMatch)) : undefined,
        )
        .groupBy(schema.tenants.id)
        .orderBy(desc(schema.tenants.createdAt))
        .limit(RESULT_LIMIT);
    }),

  listUsers: systemAdminProcedure
    .input(z.object({ search: z.string().trim().default("") }).default({}))
    .query(async ({ input }) => {
      return db
        .select({
          id: schema.user.id,
          name: schema.user.name,
          email: schema.user.email,
          role: schema.user.role,
          isSystemAdmin: schema.user.isSystemAdmin,
          removedAt: schema.user.removedAt,
          tenantId: schema.user.tenantId,
          tenantName: schema.tenants.name,
        })
        .from(schema.user)
        .innerJoin(schema.tenants, eq(schema.tenants.id, schema.user.tenantId))
        .where(
          input.search
            ? or(
                ilike(schema.user.name, `%${input.search}%`),
                ilike(schema.user.email, `%${input.search}%`),
                ilike(schema.tenants.name, `%${input.search}%`),
              )
            : undefined,
        )
        .orderBy(desc(schema.user.createdAt))
        .limit(RESULT_LIMIT);
    }),

  getTenant: systemAdminProcedure
    .input(z.object({ tenantId: z.string().uuid() }))
    .query(async ({ input }) => {
      const [tenant] = await db.select().from(schema.tenants).where(eq(schema.tenants.id, input.tenantId));
      // Every user ever in this tenant, not just active members (listMembers/@galm/core
      // filters to non-removed) - a system admin reviewing an org wants the full picture,
      // including who's been removed and who's already a system admin themselves.
      const members = await db
        .select({
          id: schema.user.id,
          name: schema.user.name,
          email: schema.user.email,
          role: schema.user.role,
          isSystemAdmin: schema.user.isSystemAdmin,
          removedAt: schema.user.removedAt,
          createdAt: schema.user.createdAt,
        })
        .from(schema.user)
        .where(eq(schema.user.tenantId, input.tenantId))
        .orderBy(desc(schema.user.createdAt));
      return { tenant, members };
    }),

  renameTenant: systemAdminProcedure
    .input(z.object({ tenantId: z.string().uuid(), name: z.string().trim().min(1).max(200) }))
    .mutation(async ({ ctx, input }) => {
      const [previous] = await db
        .select({ name: schema.tenants.name })
        .from(schema.tenants)
        .where(eq(schema.tenants.id, input.tenantId));
      if (!previous) throw new TRPCError({ code: "NOT_FOUND", message: "Organization not found." });

      await db.update(schema.tenants).set({ name: input.name }).where(eq(schema.tenants.id, input.tenantId));
      await auditAsSystemAdmin(ctx.session.user.id, input.tenantId, {
        action: "admin.tenant_renamed",
        entityType: "tenant",
        entityId: input.tenantId,
        payload: { from: previous.name, to: input.name },
      });
      return { ok: true };
    }),

  setTenantSuspended: systemAdminProcedure
    .input(z.object({ tenantId: z.string().uuid(), suspended: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const [tenant] = await db
        .select({ id: schema.tenants.id })
        .from(schema.tenants)
        .where(eq(schema.tenants.id, input.tenantId));
      if (!tenant) throw new TRPCError({ code: "NOT_FOUND", message: "Organization not found." });

      await db.update(schema.tenants).set({ suspended: input.suspended }).where(eq(schema.tenants.id, input.tenantId));
      await auditAsSystemAdmin(ctx.session.user.id, input.tenantId, {
        action: input.suspended ? "admin.tenant_suspended" : "admin.tenant_unsuspended",
        entityType: "tenant",
        entityId: input.tenantId,
      });
      return { ok: true };
    }),

  setUserSystemAdmin: systemAdminProcedure
    .input(z.object({ userId: z.string(), isSystemAdmin: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      // Revoking your own flag is the one move with no way back: system admin is granted
      // by scripts/set-system-admin.ts against the database, so the last one to switch
      // themselves off locks the console for everyone until someone gets shell access.
      if (input.userId === ctx.session.user.id && !input.isSystemAdmin) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "You can't revoke your own system admin access. Ask another system admin to do it.",
        });
      }

      const [target] = await db
        .select({ tenantId: schema.user.tenantId, email: schema.user.email })
        .from(schema.user)
        .where(eq(schema.user.id, input.userId));
      if (!target) throw new TRPCError({ code: "NOT_FOUND", message: "User not found." });

      await db.update(schema.user).set({ isSystemAdmin: input.isSystemAdmin }).where(eq(schema.user.id, input.userId));
      await auditAsSystemAdmin(ctx.session.user.id, target.tenantId, {
        action: input.isSystemAdmin ? "admin.system_admin_granted" : "admin.system_admin_revoked",
        entityType: "user",
        entityId: input.userId,
        payload: { email: target.email },
      });
      return { ok: true };
    }),

  // Org-level role (member/admin within their own tenant) - distinct from
  // setUserSystemAdmin above (that's the flat, cross-tenant flag). A system admin needs
  // this for support cases like an org's only admin being unreachable - the tenant's own
  // admins already have this via members.ts's orgAdminProcedure-gated updateRole; this is
  // the same underlying operation, just reachable without being a member of that tenant.
  setUserRole: systemAdminProcedure
    .input(z.object({ userId: z.string(), tenantId: z.string().uuid(), role: z.enum(["admin", "member"]) }))
    .mutation(async ({ ctx, input }) => {
      await updateMemberRole(db, input.tenantId, input.userId, input.role).catch(toBadRequest);
      await auditAsSystemAdmin(ctx.session.user.id, input.tenantId, {
        action: "admin.member_role_changed",
        entityType: "user",
        entityId: input.userId,
        payload: { role: input.role },
      });
      return { ok: true };
    }),
});
