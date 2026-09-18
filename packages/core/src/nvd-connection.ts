import { type TenantTx, schema } from "@galm/db";
import { eq } from "drizzle-orm";
import { DomainError } from "./errors";

export interface NvdConnectionInput {
  /** Omit (undefined) to leave the saved key unchanged. Pass `null` or `""` to clear a
   * previously-saved key back to "no key" - unlike Spira/LLM connections, "no key" is a
   * legitimate, fully working end state here (NVD's public rate limit still works), not
   * an error, so this input must be able to express clearing it explicitly rather than
   * relying on "empty means keep existing". */
  apiKey?: string | null;
}

export async function getNvdConnection(db: TenantTx, tenantId: string) {
  const [row] = await db.select().from(schema.nvdConnections).where(eq(schema.nvdConnections.tenantId, tenantId));
  return row ?? null;
}

export async function saveNvdConnection(db: TenantTx, tenantId: string, input: NvdConnectionInput) {
  const existing = await getNvdConnection(db, tenantId);
  const apiKey = input.apiKey === undefined ? (existing?.apiKey ?? null) : input.apiKey || null;

  const [row] = await db
    .insert(schema.nvdConnections)
    .values({ tenantId, apiKey })
    .onConflictDoUpdate({
      target: schema.nvdConnections.tenantId,
      set: { apiKey, updatedAt: new Date() },
    })
    .returning();
  if (!row) throw new DomainError("failed to save NVD connection");
  return row;
}
