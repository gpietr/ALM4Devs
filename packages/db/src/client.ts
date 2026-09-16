import { SQL } from "bun";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import * as schema from "./schema";

// Deliberately do NOT throw here when the env var is missing. better-auth's config (and
// therefore this client) gets constructed at module load time, which Next.js also runs
// during its build-time "collecting page data" step in a build environment that may have
// no real DATABASE_URL at all (e.g. a self-host Docker build, run before Postgres is even
// reachable). Bun's SQL client connects lazily on first query, so construction itself
// must never fail - only an actual query at real request time should, by which point the
// running container has the real env var. A missing value here is a genuine
// misconfiguration, but it should surface as "queries fail at runtime," not "the build
// itself won't complete."
const UNSET_PLACEHOLDER = "postgres://unset:unset@unset.invalid:5432/unset";

/**
 * Migration-owner connection: DDL rights, bypasses RLS. Only ever used by
 * `bun run db:migrate` (see migrate.ts) and the seed/verification scripts under /scripts -
 * never by apps/web or apps/worker at runtime.
 */
export function createAdminDb(connectionString = process.env.DATABASE_MIGRATION_URL) {
  if (!connectionString) {
    console.warn("[db] DATABASE_MIGRATION_URL is not set - queries will fail at connect time");
  }
  const client = new SQL(connectionString ?? UNSET_PLACEHOLDER);
  return drizzle({ client, schema });
}

/**
 * App-runtime connection: RLS-bound, no DDL rights. This is the only DB credential
 * apps/web and apps/worker ever connect as.
 */
export function createAppDb(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) {
    console.warn("[db] DATABASE_URL is not set - queries will fail at connect time");
  }
  const client = new SQL(connectionString ?? UNSET_PLACEHOLDER);
  return drizzle({ client, schema });
}

export type AppDb = ReturnType<typeof createAppDb>;

/**
 * A transaction handle opened by `withTenant`, with `app.tenant_id` already set for its
 * duration - the same runtime type as `AppDb`, branded at the type level only, so it
 * carries no runtime cost or property. packages/core's domain functions all declare their
 * `db` parameter as `TenantTx` rather than `AppDb`: that turns "this function must be
 * called from inside withTenant's transaction" from a doc-comment convention (see e.g. the
 * old nextSequenceNumber comment) into something the compiler actually checks - a call
 * site that accidentally passes the raw connection pool (bypassing RLS/tenant scoping)
 * fails to typecheck instead of only surfacing later as a runtime RLS rejection, or worse,
 * a cross-tenant query RLS doesn't happen to catch.
 */
declare const tenantTxBrand: unique symbol;
export type TenantTx = AppDb & { readonly [tenantTxBrand]: true };

/**
 * Every tenant-scoped request must run its DB work through this helper. It opens a
 * transaction, sets `app.tenant_id` for the duration of that transaction only (SET LOCAL,
 * never a session-wide SET, so it can't leak across pooled connections), and runs the
 * RLS policies keyed on `current_setting('app.tenant_id')` bind against it. `tenantId`
 * must come from the authenticated session server-side - never from client input.
 */
export async function withTenant<T>(
  db: AppDb,
  tenantId: string,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx as unknown as TenantTx);
  });
}

export * as schema from "./schema";
