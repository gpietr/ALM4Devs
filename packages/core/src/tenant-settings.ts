import { type TenantTx, schema } from "@galm/db";
import { eq } from "drizzle-orm";

/**
 * Per-tenant approval-process settings. Both default to false ("not required by
 * default") - a tenant opts into a stricter process, it isn't forced on them. Governs the
 * "approved"/"baselined" gate in requirements.ts: whether it needs a formal e-signature,
 * and/or a reviewer who isn't the requirement version's own author.
 */
export interface TenantApprovalSettings {
  requireEsignature: boolean;
  requireIndependentReview: boolean;
}

const DEFAULT_SETTINGS: TenantApprovalSettings = {
  requireEsignature: false,
  requireIndependentReview: false,
};

/** Called once, right after a tenant is created (see apps/web/src/app/api/register). */
export async function seedDefaultTenantSettings(db: TenantTx, tenantId: string) {
  const [row] = await db
    .insert(schema.tenantSettings)
    .values({ tenantId, ...DEFAULT_SETTINGS })
    .returning();
  return row;
}

/**
 * Defensive read: falls back to the same defaults a missing row would have had, rather
 * than throwing, if a tenant somehow doesn't have a settings row yet (the exact class of
 * gap `scripts/backfill-tenant-defaults.ts` exists to close - see TECH_STACK.md). A
 * missing *settings* row failing open to "nothing extra required" is the safe direction
 * for a missing row to fail in, unlike a missing *status* row, which has nothing safe to
 * fall back to.
 */
export async function getTenantSettings(db: TenantTx, tenantId: string): Promise<TenantApprovalSettings> {
  const [row] = await db.select().from(schema.tenantSettings).where(eq(schema.tenantSettings.tenantId, tenantId));
  if (!row) return DEFAULT_SETTINGS;
  return { requireEsignature: row.requireEsignature, requireIndependentReview: row.requireIndependentReview };
}

export async function updateTenantSettings(
  db: TenantTx,
  tenantId: string,
  patch: Partial<TenantApprovalSettings>,
): Promise<TenantApprovalSettings> {
  const [row] = await db
    .insert(schema.tenantSettings)
    .values({ tenantId, ...DEFAULT_SETTINGS, ...patch })
    .onConflictDoUpdate({
      target: schema.tenantSettings.tenantId,
      set: { ...patch, updatedAt: new Date() },
    })
    .returning();
  return { requireEsignature: row!.requireEsignature, requireIndependentReview: row!.requireIndependentReview };
}
