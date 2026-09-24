import { type TenantTx, schema } from "@galm/db";
import { eq } from "drizzle-orm";
import { DomainError } from "./errors";
import { assertSafeOutboundUrl, normalizeOutboundUrl } from "./outbound-url";

export interface SpiraConnectionInput {
  baseUrl: string;
  apiVersion: string;
  username: string;
  /** Optional on save so the UI can let you update other fields (base URL, project id)
   * without re-entering a key you've already saved - omit or send empty to keep the
   * existing one. */
  apiKey?: string;
  projectId: number;
}

export async function getSpiraConnection(db: TenantTx, tenantId: string) {
  const [row] = await db.select().from(schema.spiraConnections).where(eq(schema.spiraConnections.tenantId, tenantId));
  return row ?? null;
}

export async function saveSpiraConnection(db: TenantTx, tenantId: string, input: SpiraConnectionInput) {
  const existing = await getSpiraConnection(db, tenantId);
  const baseUrl = assertSafeOutboundUrl(input.baseUrl, "The Spira base URL");

  // Carrying the saved key over to a *different* base URL is how a saved credential walks
  // out of the building: change the host, leave apiKey empty, hit "Test connection", and
  // the stored key is handed to whatever now answers at that address. Keeping the key
  // across edits is a real convenience (see SpiraConnectionInput.apiKey) - it just can't
  // survive a change of who we're sending it to.
  if (existing && baseUrl !== normalizeOutboundUrl(existing.baseUrl) && !input.apiKey) {
    throw new DomainError("Re-enter the API key to point this connection at a different base URL.");
  }

  const apiKey = input.apiKey || existing?.apiKey;
  if (!apiKey) {
    throw new DomainError("an API key is required (this connection has never been saved before)");
  }

  const [row] = await db
    .insert(schema.spiraConnections)
    .values({
      tenantId,
      baseUrl,
      apiVersion: input.apiVersion,
      username: input.username,
      apiKey,
      projectId: input.projectId,
    })
    .onConflictDoUpdate({
      target: schema.spiraConnections.tenantId,
      set: {
        baseUrl,
        apiVersion: input.apiVersion,
        username: input.username,
        apiKey,
        projectId: input.projectId,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!row) throw new DomainError("failed to save Spira connection");
  return row;
}
