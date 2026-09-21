import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  seedDefaultArchitectureLevels,
  seedDefaultCustomFields,
  seedDefaultLevels,
  seedDefaultStatuses,
  seedDefaultTenantSettings,
  seedDefaultTestLevels,
} from "@galm/core";
import { schema, withTenant } from "@galm/db";
import { APIError } from "better-auth";
import { NextResponse } from "next/server";
import { z } from "zod";

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
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { orgName, name, email, password } = parsed.data;

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
  });

  try {
    // asResponse: true returns a real Response (cookies already set on it) instead of
    // throwing/returning a plain object - forward it as-is so the session cookie reaches
    // the browser exactly as it would via the normal /api/auth/sign-up/email route.
    return await auth.api.signUpEmail({
      body: { name, email, password, tenantId: tenant.id },
      asResponse: true,
    });
  } catch (err) {
    // The tenant row above is now orphaned (no user in it). Harmless for the walking
    // skeleton's scope - an empty, unreachable tenant - but worth a TODO for backlog item 1:
    // wrap this in a transaction once tenant creation and sign-up can share one.
    if (err instanceof APIError) {
      return NextResponse.json({ error: err.body?.message ?? err.message }, { status: err.statusCode ?? 400 });
    }
    throw err;
  }
}
