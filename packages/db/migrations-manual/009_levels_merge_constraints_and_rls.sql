-- Completes migrations/0011_merge_levels.sql (which only creates the new, empty `levels`
-- table - see its header comment for why the rest had to be split out here): backfills
-- every existing requirement_levels/test_levels row into `levels`, adds the CHECK
-- constraint and RLS the drizzle-generated file can't emit, then drops the two old tables
-- and rewires every FK/unique constraint that pointed at them onto `levels`. Runs after
-- migrations-manual/004 and 005 in filename order, which matters: those still enable RLS,
-- seed defaults, and add constraints against requirement_levels/test_levels, so this file
-- has to run after them, not before - see packages/db/src/schema.ts's `levels` docstring
-- for the full reasoning behind the merge.

-- --- Backfill: copy every existing row into the new shared table, preserving id --------
-- Preserving each row's original id means requirements.level_id/test_cases.level_id/
-- level_sequence_counters.level_id (all still pointing at the old ids at this point) keep
-- resolving correctly without themselves needing to change - only the FK constraints
-- naming the old target table get rewired below.

INSERT INTO levels (id, tenant_id, kind, name, code, sort_order, created_at)
SELECT id, tenant_id, 'requirement', name, code, sort_order, created_at FROM requirement_levels;

-- test_levels had its own separate (tenant_id, code) uniqueness domain, so a code here can
-- collide with one already copied from requirement_levels above even though neither source
-- table had an internal duplicate - `levels` now has one shared uniqueness domain across
-- both kinds (see its docstring), which is the whole point of the merge. De-duplicate any
-- such collision by suffixing with this row's own short id, same pattern
-- migrations/0010_loving_spirit.sql used for the analogous generic-fallback-code collision.
INSERT INTO levels (id, tenant_id, kind, name, code, sort_order, created_at)
SELECT
  tl.id,
  tl.tenant_id,
  'test',
  tl.name,
  CASE
    WHEN EXISTS (SELECT 1 FROM levels l WHERE l.tenant_id = tl.tenant_id AND l.code = tl.code)
    THEN tl.code || '_' || left(tl.id::text, 4)
    ELSE tl.code
  END,
  tl.sort_order,
  tl.created_at
FROM test_levels tl;

-- --- Fixed, code-understood value set, enforced as a CHECK constraint ------------------
-- Same pattern as requirements.safety_classification/test_cases.test_type - see
-- packages/core's LevelKind.

alter table levels drop constraint if exists levels_kind_check;
alter table levels add constraint levels_kind_check
  check (kind in ('requirement', 'test'));

-- A tenant may rename a level, but never end up with two active ones of the *same kind*
-- sharing a name - same reasoning as requirement_statuses. Replaces the old
-- requirement_levels_tenant_name_unique/test_levels_tenant_name_unique constraints (each
-- table had its own name-uniqueness domain before the merge); deliberately scoped by
-- kind, unlike `code` (levels_tenant_id_code_unique, added directly in 0011's CREATE
-- TABLE) which is intentionally NOT kind-scoped - see the `levels` table's docstring in
-- packages/db/src/schema.ts for why code collapses to one shared namespace while name
-- does not.
alter table levels drop constraint if exists levels_tenant_id_kind_name_unique;
alter table levels add constraint levels_tenant_id_kind_name_unique
  unique (tenant_id, kind, name);

-- --- Row Level Security ---------------------------------------------------------------
-- Same reasoning as every prior manual migration: plain ENABLE (not FORCE) - app_runtime
-- never owns this table, and galm_migrator (the owner) needs unrestricted access for
-- admin/seed/backfill work.

alter table levels enable row level security;
drop policy if exists tenant_isolation on levels;
create policy tenant_isolation on levels
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- --- Drop the old tables and rewire every FK/constraint onto `levels` ------------------
-- Explicit FK drops first, then plain (non-CASCADE) DROP TABLE: dropping requirement_id
-- levels/test_levels with CASCADE would silently drop these same FK constraints as a side
-- effect, which is harder to reason about than dropping them by name and then dropping
-- the now-unreferenced table outright.

alter table requirements drop constraint if exists requirements_level_id_requirement_levels_id_fk;
alter table test_cases drop constraint if exists test_cases_level_id_test_levels_id_fk;

alter table requirement_levels disable row level security;
alter table test_levels disable row level security;
drop table requirement_levels;
drop table test_levels;

-- level_sequence_counters.level_id had no real FK before the merge (see its old schema
-- comment - it pointed at whichever of the two old tables actually owned the id, with
-- nothing in the schema saying which). It gets a genuine one now, and its primary key
-- grows tenant_id to match every other tenant-scoped table's key convention (see
-- packages/db/src/schema.ts's levelSequenceCounters docstring) - product_id already
-- implied a tenant via its own FK, so this is consistency, not a fix for an observed bug.

alter table level_sequence_counters drop constraint if exists level_sequence_counters_product_id_level_id_pk;
alter table level_sequence_counters add constraint level_sequence_counters_tenant_id_product_id_level_id_pk
  primary key (tenant_id, product_id, level_id);
alter table level_sequence_counters drop constraint if exists level_sequence_counters_level_id_levels_id_fk;
alter table level_sequence_counters add constraint level_sequence_counters_level_id_levels_id_fk
  foreign key (level_id) references levels(id) on delete cascade;

alter table requirements drop constraint if exists requirements_level_id_levels_id_fk;
alter table requirements add constraint requirements_level_id_levels_id_fk
  foreign key (level_id) references levels(id);
alter table test_cases drop constraint if exists test_cases_level_id_levels_id_fk;
alter table test_cases add constraint test_cases_level_id_levels_id_fk
  foreign key (level_id) references levels(id);

-- The invariant nextSequenceNumber's atomic counter is meant to guarantee, enforced
-- independently at the database level - see packages/db/src/schema.ts's requirements/
-- test_cases docstrings.
alter table requirements drop constraint if exists requirements_product_id_level_id_sequence_number_unique;
alter table requirements add constraint requirements_product_id_level_id_sequence_number_unique
  unique (product_id, level_id, sequence_number);
alter table test_cases drop constraint if exists test_cases_product_id_level_id_sequence_number_unique;
alter table test_cases add constraint test_cases_product_id_level_id_sequence_number_unique
  unique (product_id, level_id, sequence_number);
