-- Test sets: a named, ordered, reusable subset of tests to run. Drizzle-generated
-- migrations/0026_test_sets.sql creates the tables and FKs; this file adds the RLS that
-- drizzle-kit can't emit (same split as every other manual migration in this directory),
-- plus widening custom_field_definitions' entity_type CHECK to also allow 'test_run' -
-- "custom parameters on a test set entry" reuses the existing tenant-defined custom
-- fields system (packages/core/src/custom-fields.ts) rather than a new mechanism.

alter table custom_field_definitions drop constraint if exists custom_field_definitions_entity_type_check;
alter table custom_field_definitions add constraint custom_field_definitions_entity_type_check
  check (entity_type in ('requirement', 'test_case', 'test_run'));

alter table test_sets enable row level security;
drop policy if exists tenant_isolation on test_sets;
create policy tenant_isolation on test_sets
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table test_set_items enable row level security;
drop policy if exists tenant_isolation on test_set_items;
create policy tenant_isolation on test_set_items
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
