-- Architecture nodes + architecture as a third `levels.kind`. Drizzle-generated
-- migrations/0016_architecture_nodes.sql creates the table and FKs; this file adds the
-- CHECKs and RLS that drizzle-kit can't emit (same split as every other manual
-- migration in this directory).

-- --- Fixed, code-understood value sets, enforced as CHECK constraints -----------------

alter table levels drop constraint if exists levels_kind_check;
alter table levels add constraint levels_kind_check
  check (kind in ('requirement', 'test', 'architecture'));

alter table architecture_nodes drop constraint if exists architecture_nodes_kind_check;
alter table architecture_nodes add constraint architecture_nodes_kind_check
  check (kind in ('software_item', 'software_unit', 'ots'));

-- --- Row Level Security ---------------------------------------------------------------
-- Same reasoning as every prior manual migration: plain ENABLE (not FORCE) - app_runtime
-- never owns this table, and galm_migrator (the owner) needs unrestricted access.

alter table architecture_nodes enable row level security;
drop policy if exists tenant_isolation on architecture_nodes;
create policy tenant_isolation on architecture_nodes
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
