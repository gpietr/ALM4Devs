-- Hand-edited to a no-op. drizzle-kit generated this as `ALTER TABLE requirements DROP
-- COLUMN "type"`, which is correct as the END state but cannot run here: drizzle's own
-- migrations (this file included) all run before any migrations-manual/*.sql file, and
-- migrations-manual/004 needs to read the still-existing `type` column to backfill
-- `level_id` first. The real DROP COLUMN happens there, after that backfill. This file is
-- kept in the migrations folder (rather than deleted) purely so its accompanying snapshot
-- - which does reflect the true end state (no `type` column) - keeps drizzle-kit's
-- rename-detection bookkeeping consistent for future `drizzle-kit generate` runs.
SELECT 1;
