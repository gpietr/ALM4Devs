import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { rateLimit, ruleFromEnv } from "@/server/rate-limit";
import {
  seedDefaultArchitectureLevels,
  seedDefaultCustomFields,
  seedDefaultDocumentTemplates,
  seedDefaultLevels,
  seedDefaultStatuses,
  seedDefaultTenantSettings,
  seedDefaultTestLevels,
} from "@galm/core";
import { schema, withTenant } from "@galm/db";
import { APIError } from "better-auth";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

const REGISTER_RATE_LIMIT = ruleFromEnv("REGISTER", { window: 10, max: 3 });

/**
 * Combined "create your organization + your account" registration: the product's
 * target customer is a small company signing up, not an individual joining an existing
 * org, so registration creates a new tenant and its first user in one step. `tenants` has
 * no RLS (it's the tenant-defining table itself), so the normal app_runtime connection can
 * insert into it directly - no need for the migration-owner credential here.
 */
const bodySchema = z.object({
  orgName: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(200),
  email: z.string().email(),
  password: z.string().min(8).max(200),
});

export async function POST(req: Request) {
  // Same ceiling better-auth puts on its own /sign-up path, which this route bypasses by
  // calling signUpEmail in-process. Note this is a *secondary* control: the reason a
  // flood of these used to be cheap - a tenant row plus six sets of seeded defaults per
  // rejected attempt - is fixed by the duplicate check and rollback below, so an attacker
  // who defeats this (rotating IPs, say) now gets real, email-verifiable tenants at one
  // sign-up's cost each rather than free churn.
  const limited = rateLimit(req, "register", REGISTER_RATE_LIMIT);
  if (limited) return limited;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { orgName, name, password } = parsed.data;
  // better-auth lowercases on sign-up and user.email is globally unique, so the stored
  // form is always lowercase - match that here rather than comparing case-sensitively
  // against what the caller typed (same normalization as @galm/core's createInvitation).
  const email = parsed.data.email.trim().toLowerCase();

  // Checked *before* the tenant insert below, not left to signUpEmail's own uniqueness
  // error. That error arrives after we've already created the tenant and seeded its six
  // sets of defaults, and the rollback for it is the `catch` at the bottom - which makes
  // an unauthenticated POST with a known-taken email a free way to churn tenant rows.
  // This isn't a substitute for the rollback (two concurrent requests can both pass it),
  // but it turns the ordinary, repeatable case into one indexed SELECT and no writes.
  const [existingUser] = await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.email, email));
  if (existingUser) {
    return NextResponse.json({ error: "An account with this email address already exists." }, { status: 422 });
  }

  const [tenant] = await db.insert(schema.tenants).values({ name: orgName }).returning();
  if (!tenant) {
    return NextResponse.json({ error: "failed to create organization" }, { status: 500 });
  }

  // All RLS-protected, so seeding needs the tenant context set even though these are the
  // tenant's very first rows.
  await withTenant(db, tenant.id, async (tx) => {
    await seedDefaultStatuses(tx, tenant.id);
    await seedDefaultLevels(tx, tenant.id);
    await seedDefaultTenantSettings(tx, tenant.id);
    await seedDefaultTestLevels(tx, tenant.id);
    await seedDefaultArchitectureLevels(tx, tenant.id);
    await seedDefaultCustomFields(tx, tenant.id);
    await seedDefaultDocumentTemplates(tx, tenant.id);
  });

  const tenantId = tenant.id;
  /**
   * Sign-up failed, so the tenant created above has no user and never will - delete it
   * rather than leaving it orphaned. Not a real transaction (signUpEmail opens its own and
   * can't join ours - still backlog item 1), but it covers the same ground in practice:
   * `tenants` cascades, so this takes the seeded defaults with it. Best-effort by design -
   * a failed cleanup must not replace the caller's real error with a confusing one.
   */
  async function discardTenant() {
    await db
      .delete(schema.tenants)
      .where(eq(schema.tenants.id, tenantId))
      .catch((err) => console.error("[register] failed to clean up orphaned tenant:", err));
  }

  try {
    // asResponse: true returns a real Response (cookies already set on it) instead of
    // throwing/returning a plain object - forward it as-is so the session cookie reaches
    // the browser exactly as it would via the normal /api/auth/sign-up/email route.
    const res = await auth.api.signUpEmail({
      // The first user of a brand-new tenant is always its admin - only later invited
      // users (apps/web/src/app/api/accept-invite/route.ts) get whatever role the
      // inviting admin picked.
      body: { name, email, password, tenantId: tenant.id, role: "admin" },
      asResponse: true,
    });
    // asResponse also means better-auth reports its *own* failures as a non-ok Response
    // rather than by throwing - so a bare try/catch here would let a rejected sign-up
    // (the duplicate-email race the pre-check above can't close, a password policy
    // rejection, ...) sail past as a success and leave the tenant behind.
    if (!res.ok) {
      await discardTenant();
    }
    return res;
  } catch (err) {
    await discardTenant();
    if (err instanceof APIError) {
      return NextResponse.json({ error: err.body?.message ?? err.message }, { status: err.statusCode ?? 400 });
    }
    throw err;
  }
}
