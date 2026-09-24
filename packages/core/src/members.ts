import { randomBytes } from "node:crypto";
import { type AppDb, type TenantTx, schema } from "@galm/db";
import { and, eq, isNull } from "drizzle-orm";
import { DomainError } from "./errors";

export type OrgRole = "admin" | "member";

/** Not specified by the product requirements - easy to change, kept in one place. */
const INVITATION_EXPIRY_DAYS = 7;

function generateInvitationToken(): string {
  return randomBytes(32).toString("hex");
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface Member {
  id: string;
  name: string;
  email: string;
  role: OrgRole;
  createdAt: Date;
}

/** Active (not removed) members of a tenant. */
export async function listMembers(db: TenantTx, tenantId: string): Promise<Member[]> {
  const rows = await db
    .select({
      id: schema.user.id,
      name: schema.user.name,
      email: schema.user.email,
      role: schema.user.role,
      createdAt: schema.user.createdAt,
    })
    .from(schema.user)
    .where(and(eq(schema.user.tenantId, tenantId), isNull(schema.user.removedAt)));
  return rows as Member[];
}

export async function listPendingInvitations(db: TenantTx, tenantId: string) {
  return db
    .select({
      id: schema.invitations.id,
      email: schema.invitations.email,
      role: schema.invitations.role,
      expiresAt: schema.invitations.expiresAt,
      createdAt: schema.invitations.createdAt,
      invitedByName: schema.user.name,
    })
    .from(schema.invitations)
    .innerJoin(schema.user, eq(schema.user.id, schema.invitations.invitedBy))
    .where(and(eq(schema.invitations.tenantId, tenantId), eq(schema.invitations.status, "pending")));
}

export async function createInvitation(
  db: TenantTx,
  tenantId: string,
  input: { email: string; role: OrgRole; invitedByUserId: string },
) {
  const email = normalizeEmail(input.email);

  const [existingMember] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(and(eq(schema.user.tenantId, tenantId), eq(schema.user.email, email), isNull(schema.user.removedAt)));
  if (existingMember) throw new DomainError("This person is already a member of your organization.");

  // user.email is globally unique across every tenant - a friendly, specific error here
  // instead of a raw unique-constraint violation surfacing later at accept time.
  const [anyExistingUser] = await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.email, email));
  if (anyExistingUser) throw new DomainError("This email address is already registered to another organization.");

  const [existingPending] = await db
    .select()
    .from(schema.invitations)
    .where(and(eq(schema.invitations.tenantId, tenantId), eq(schema.invitations.email, email), eq(schema.invitations.status, "pending")));

  const token = generateInvitationToken();
  const expiresAt = new Date(Date.now() + INVITATION_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  if (existingPending) {
    const [row] = await db
      .update(schema.invitations)
      .set({ role: input.role, token, invitedBy: input.invitedByUserId, expiresAt, updatedAt: new Date() })
      .where(eq(schema.invitations.id, existingPending.id))
      .returning();
    return row!;
  }

  const [row] = await db
    .insert(schema.invitations)
    .values({ tenantId, email, role: input.role, token, invitedBy: input.invitedByUserId, expiresAt })
    .returning();
  return row!;
}

export async function revokeInvitation(db: TenantTx, tenantId: string, invitationId: string) {
  const [row] = await db
    .update(schema.invitations)
    .set({ status: "revoked", updatedAt: new Date() })
    .where(and(eq(schema.invitations.id, invitationId), eq(schema.invitations.tenantId, tenantId), eq(schema.invitations.status, "pending")))
    .returning();
  if (!row) throw new DomainError("Invitation not found or already used.");
  return row;
}

/** Called from /api/accept-invite before creating the user. Doesn't mark the invitation
 * accepted itself - see markInvitationAccepted, called only after the user is actually
 * created, so a failed sign-up never leaves a real invitation looking "used up". */
export async function acceptInvitation(db: TenantTx, tenantId: string, token: string) {
  const [row] = await db
    .select()
    .from(schema.invitations)
    .where(and(eq(schema.invitations.tenantId, tenantId), eq(schema.invitations.token, token)));
  if (!row) throw new DomainError("This invitation link is invalid.");
  if (row.status === "accepted") throw new DomainError("This invitation has already been accepted.");
  if (row.status === "revoked") throw new DomainError("This invitation has been revoked.");
  if (row.expiresAt.getTime() < Date.now()) throw new DomainError("This invitation has expired.");
  return row;
}

export async function markInvitationAccepted(db: TenantTx, tenantId: string, invitationId: string) {
  await db
    .update(schema.invitations)
    .set({ status: "accepted", acceptedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(schema.invitations.id, invitationId), eq(schema.invitations.tenantId, tenantId)));
}

// --- Role/removal: plain AppDb, not TenantTx - `user` isn't RLS-protected, so no
// withTenant transaction is needed for these. ------------------------------------------

/**
 * Guards the one state this app can't recover from on its own: a tenant with no active
 * admin. Nobody left can invite, manage members, or promote anyone, and there is no
 * self-service way back - migration 023 exists precisely because a fleet of admin-less
 * tenants had to be repaired with hand-written SQL. Cheaper to refuse the last step than
 * to write that migration again.
 *
 * Applies to system admins too (admin.ts's setUserRole reaches this same function). Their
 * documented support case is promoting *into* an org whose admin is unreachable, which
 * this doesn't touch - it only blocks removing the final one.
 */
async function assertNotLastAdmin(db: AppDb, tenantId: string, targetUserId: string, action: "remove" | "demote") {
  const [target] = await db
    .select({ role: schema.user.role })
    .from(schema.user)
    .where(and(eq(schema.user.id, targetUserId), eq(schema.user.tenantId, tenantId), isNull(schema.user.removedAt)));
  if (target?.role !== "admin") return;

  const admins = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(and(eq(schema.user.tenantId, tenantId), eq(schema.user.role, "admin"), isNull(schema.user.removedAt)));
  if (admins.length <= 1) {
    throw new DomainError(
      action === "remove"
        ? "You can't remove the organization's last admin. Make someone else an admin first."
        : "You can't change the role of the organization's last admin. Make someone else an admin first.",
    );
  }
}

export async function updateMemberRole(db: AppDb, tenantId: string, targetUserId: string, role: OrgRole) {
  if (role !== "admin") await assertNotLastAdmin(db, tenantId, targetUserId, "demote");
  const [row] = await db
    .update(schema.user)
    .set({ role, updatedAt: new Date() })
    .where(and(eq(schema.user.id, targetUserId), eq(schema.user.tenantId, tenantId), isNull(schema.user.removedAt)))
    .returning();
  if (!row) throw new DomainError("Member not found.");
  return row;
}

export async function removeMember(db: AppDb, tenantId: string, targetUserId: string) {
  await assertNotLastAdmin(db, tenantId, targetUserId, "remove");
  const [row] = await db
    .update(schema.user)
    .set({ removedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(schema.user.id, targetUserId), eq(schema.user.tenantId, tenantId), isNull(schema.user.removedAt)))
    .returning();
  if (!row) throw new DomainError("Member not found or already removed.");
  return row;
}
