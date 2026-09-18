-- Software versions (release train) + their links to requirements/test cases/OTS
-- component versions. Drizzle-generated migrations/0024_software_versions.sql creates
-- the tables and FKs; this file adds the CHECK and RLS that drizzle-kit can't emit (same
-- split as every other manual migration in this directory).

alter table software_version_links drop constraint if exists software_version_links_entity_type_check;
alter table software_version_links add constraint software_version_links_entity_type_check
  check (entity_type in ('requirement', 'test_case', 'architecture_node_version'));

alter table software_versions enable row level security;
drop policy if exists tenant_isolation on software_versions;
create policy tenant_isolation on software_versions
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table software_version_links enable row level security;
drop policy if exists tenant_isolation on software_version_links;
create policy tenant_isolation on software_version_links
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
