-- Backlog item 9.19: tenant-defined custom fields for requirements and test cases.
-- Same split as every other manual migration in this directory: the CHECK constraints
-- and RLS policies migrations/0012_custom_fields.sql (drizzle-generated) can't emit.

-- --- Fixed, code-understood value sets, enforced as CHECK constraints ------------------

alter table custom_field_definitions drop constraint if exists custom_field_definitions_entity_type_check;
alter table custom_field_definitions add constraint custom_field_definitions_entity_type_check
  check (entity_type in ('requirement', 'test_case'));

alter table custom_field_definitions drop constraint if exists custom_field_definitions_field_type_check;
alter table custom_field_definitions add constraint custom_field_definitions_field_type_check
  check (field_type in ('short_text', 'long_text', 'list', 'date', 'integer', 'boolean'));

-- --- Row Level Security ---------------------------------------------------------------
-- Same reasoning as every prior manual migration: plain ENABLE (not FORCE) - app_runtime
-- never owns these tables, and galm_migrator (the owner) needs unrestricted access for
-- admin/seed/backfill work.

alter table custom_field_definitions enable row level security;
drop policy if exists tenant_isolation on custom_field_definitions;
create policy tenant_isolation on custom_field_definitions
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table custom_field_list_options enable row level security;
drop policy if exists tenant_isolation on custom_field_list_options;
create policy tenant_isolation on custom_field_list_options
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table custom_field_values enable row level security;
drop policy if exists tenant_isolation on custom_field_values;
create policy tenant_isolation on custom_field_values
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
