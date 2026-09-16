import type { TenantTx } from "@galm/db";
import { sql } from "drizzle-orm";
import { DomainError } from "./errors";

/**
 * Atomically hands out the next sequence number for a (product, level) pair - the number
 * half of a human-readable id like SYSREQ-1 (see requirements.sequenceNumber's comment).
 * A single `insert ... on conflict do update ... returning`, not a read-then-write, so two
 * concurrent creates against the same level can't both observe "last was 4" and each save
 * "5" - Postgres serializes the second one behind the first's row lock until it commits or
 * rolls back. Must be called with the same transaction (`tx`) that creates the item it
 * numbers, so a failed creation rolls the counter back too instead of burning a number on
 * nothing.
 */
export async function nextSequenceNumber(
  db: TenantTx,
  tenantId: string,
  productId: string,
  levelId: string,
): Promise<number> {
  const [row] = await db.execute<{ last_number: number }>(sql`
    insert into level_sequence_counters (tenant_id, product_id, level_id, last_number)
    values (${tenantId}, ${productId}, ${levelId}, 1)
    on conflict (tenant_id, product_id, level_id)
    do update set last_number = level_sequence_counters.last_number + 1
    returning last_number
  `);
  if (!row) throw new DomainError("failed to assign a sequence number");
  return row.last_number;
}

/**
 * Bumps a (product, level) counter up to at least `atLeast`, without necessarily
 * incrementing by exactly 1 - used when an item is created with an explicit, externally-
 * supplied sequence number (e.g. a legacy id read from a Spira import - see
 * packages/integrations/spira/src/legacy-id.ts) instead of the next auto-assigned one, so
 * later organic creates at this (product, level) never collide with it. A no-op if the
 * counter is already >= atLeast (`greatest`, not a plain overwrite). Same transaction
 * requirement as nextSequenceNumber - must run inside the transaction that creates the
 * item it's securing room for.
 */
export async function ensureSequenceCounterAtLeast(
  db: TenantTx,
  tenantId: string,
  productId: string,
  levelId: string,
  atLeast: number,
): Promise<void> {
  await db.execute(sql`
    insert into level_sequence_counters (tenant_id, product_id, level_id, last_number)
    values (${tenantId}, ${productId}, ${levelId}, ${atLeast})
    on conflict (tenant_id, product_id, level_id)
    do update set last_number = greatest(level_sequence_counters.last_number, excluded.last_number)
  `);
}

/**
 * Gives a number back to the pool, but only the *one specific case* where doing so can't
 * possibly create an ambiguous id later: deleting the item that currently holds the
 * highest number ever handed out for this (product, level) - the "tip". Backlog item
 * 9.28, prompted directly by the user after needing a hand-run SQL fix
 * (subtracting a fixed amount from both a whole level's sequence numbers and its counter)
 * to undo exactly the gap a naive delete leaves behind - "when deleting the tip, maybe
 * decrement the ID counter?".
 *
 * One atomic, conditional `UPDATE`, not a read-then-write: `last_number = last_number - 1
 * WHERE last_number = sequenceNumber` only ever succeeds if the counter is *still* sitting
 * exactly on the number being deleted at the moment this runs. If some other transaction
 * already claimed the next number in between (nextSequenceNumber/
 * ensureSequenceCounterAtLeast, both real, concurrent writers against this same row), the
 * counter has already moved past `sequenceNumber` and this simply matches zero rows -
 * silently leaving the counter untouched, the same permanent-gap behavior deleting
 * anything else already has. Never wrong, only sometimes a no-op; must run inside the same
 * transaction that deletes the item itself, same requirement as its siblings above.
 *
 * Deliberately narrow: this is not "find the highest remaining number and reset to that"
 * (which would need to inspect every other still-existing row) or a multi-step
 * gap-compaction feature - just "undo handing out this one number", exactly what was
 * asked for, and exactly what's safe to do without touching anything else. Repeated tip
 * deletes (delete the top item, then the new top item, ...) walk the counter back one step
 * at a time correctly, since each call re-checks against the counter's *current* value,
 * not a value captured earlier.
 */
export async function decrementSequenceCounterIfTip(
  db: TenantTx,
  tenantId: string,
  productId: string,
  levelId: string,
  sequenceNumber: number,
): Promise<boolean> {
  // `returning`, not inspecting the statement's affected-row count - confirmed directly
  // that this driver's `db.execute` gives back no row-count metadata at all for a plain
  // UPDATE (an empty array either way, matched or not), so `returning` is the only
  // reliable way to tell whether the conditional WHERE actually matched a row, same
  // reasoning nextSequenceNumber above already uses `returning` for its own upsert.
  const [row] = await db.execute<{ last_number: number }>(sql`
    update level_sequence_counters
    set last_number = last_number - 1
    where tenant_id = ${tenantId} and product_id = ${productId} and level_id = ${levelId}
      and last_number = ${sequenceNumber}
    returning last_number
  `);
  return row !== undefined;
}

/** Normalizes a user-entered level code to the form it's actually stored/displayed in:
 * trimmed, uppercased, alphanumeric only (a code is a display prefix like "SYSREQ" glued
 * to a number with a hyphen - spaces or punctuation in it would just be confusing). */
export function normalizeLevelCode(raw: string): string {
  const cleaned = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!cleaned) throw new DomainError("code must contain at least one letter or digit");
  if (cleaned.length > 20) throw new DomainError("code must be 20 characters or fewer");
  return cleaned;
}

/** True for a Postgres unique_violation (SQLSTATE 23505), however the driver/ORM happens
 * to have wrapped it. Two real wrinkles, both confirmed by actually triggering one and
 * inspecting the thrown error rather than guessing: (1) Drizzle's bun-sql dialect re-throws
 * its own `DrizzleQueryError`, with the real driver error attached as `.cause`, not merged
 * into the error it hands back - a plain `"code" in err` check on the top-level error
 * always misses it. (2) Bun's native Postgres driver puts its own generic
 * `"ERR_POSTGRES_SERVER_ERROR"` in `.code` on that inner error and the real Postgres
 * SQLSTATE in `.errno` instead (a node-postgres-style driver would put it in `.code`
 * directly) - so both properties need checking, not just one. Walks a short `.cause` chain
 * (bounded, in case something ever wraps twice) rather than assuming a fixed depth. */
export function isUniqueViolation(err: unknown): boolean {
  let current = err;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (typeof current === "object") {
      const { code, errno } = current as { code?: unknown; errno?: unknown };
      if (code === "23505" || errno === "23505") return true;
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

/** Rethrows a unique-constraint violation on a level's (tenant_id, code) as a friendly
 * DomainError; anything else passes through unchanged. Shared by requirement-levels.ts and
 * test-levels.ts's createLevel/createTestLevel and updateLevelCode/updateTestLevelCode. */
export function rethrowDuplicateLevelCode(err: unknown): never {
  if (isUniqueViolation(err)) {
    throw new DomainError("a level with that code already exists - codes must be unique");
  }
  throw err;
}

