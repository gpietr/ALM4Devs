import { type TenantTx, schema } from "@galm/db";
import { eq } from "drizzle-orm";
import { DomainError } from "./errors";

export interface GithubConnectionInput {
  /** Omit to keep the saved token; `null` or `""` clears it. */
  token?: string | null;
}

export async function getGithubConnection(db: TenantTx, tenantId: string) {
  const [row] = await db.select().from(schema.githubConnections).where(eq(schema.githubConnections.tenantId, tenantId));
  return row ?? null;
}

export async function saveGithubConnection(db: TenantTx, tenantId: string, input: GithubConnectionInput) {
  const existing = await getGithubConnection(db, tenantId);
  const token = input.token === undefined ? (existing?.token ?? null) : input.token || null;

  const [row] = await db
    .insert(schema.githubConnections)
    .values({ tenantId, token })
    .onConflictDoUpdate({
      target: schema.githubConnections.tenantId,
      set: { token, updatedAt: new Date() },
    })
    .returning();
  if (!row) throw new DomainError("failed to save GitHub connection");
  return row;
}
