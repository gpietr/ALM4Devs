import { createAppDb } from "@galm/db";

/**
 * The one shared connection pool for the whole apps/web process. Every route handler and
 * tRPC router imports this instead of calling createAppDb() itself.
 *
 * Real incident: this feature grew to ten files (auth, four routers, four route handlers)
 * each independently calling `const db = createAppDb()` at module scope. Each call is
 * correct in isolation (module scope, not per-request - see the note in lib/reauth.ts for
 * that other, different mistake), but each one *also* opens its own connection pool - ten
 * separate pools collectively exhausted Postgres's connection ceiling even with zero
 * per-request leaking anywhere. One shared pool for the whole process is what every other
 * part of this stack already assumes exists.
 */
export const db = createAppDb();
