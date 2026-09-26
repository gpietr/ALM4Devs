-- OTS documentation. migrations/0031_ots_documentation.sql creates the tables and FKs;
-- this file adds the CHECKs and RLS drizzle-kit can't emit.

-- --- CHECK constraints (mirroring constants in packages/core/src/ots.ts) ----------------

alter table architecture_node_versions drop constraint if exists architecture_node_versions_support_status_check;
alter table architecture_node_versions add constraint architecture_node_versions_support_status_check
  check (support_status in ('in_use', 'allowed', 'retired'));

alter table ots_profiles drop constraint if exists ots_profiles_category_check;
alter table ots_profiles add constraint ots_profiles_category_check
  check (category is null or category in (
    'operating_system', 'driver', 'utility', 'library', 'framework', 'runtime',
    'database', 'cloud_service', 'firmware', 'build_tool', 'other'
  ));

alter table ots_anomalies drop constraint if exists ots_anomalies_outcome_check;
alter table ots_anomalies add constraint ots_anomalies_outcome_check
  check (outcome is null or outcome in ('not_applicable', 'acceptable', 'mitigated', 'not_acceptable'));

-- An OTS item can't be its own platform (the app layer rejects it too).
alter table ots_platform_links drop constraint if exists ots_platform_links_not_self_check;
alter table ots_platform_links add constraint ots_platform_links_not_self_check
  check (architecture_node_id <> platform_node_id);

-- Adds the ots_list and ots_component document template scopes to 011's CHECK.
alter table document_templates drop constraint if exists document_templates_scope_check;
alter table document_templates add constraint document_templates_scope_check
  check (scope in ('test_case', 'test_execution', 'requirement_list', 'ots_list', 'ots_component'));

-- --- Row Level Security ---------------------------------------------------------------
-- Plain ENABLE (not FORCE), as in every prior manual migration.

alter table ots_profiles enable row level security;
drop policy if exists tenant_isolation on ots_profiles;
create policy tenant_isolation on ots_profiles
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table ots_platform_links enable row level security;
drop policy if exists tenant_isolation on ots_platform_links;
create policy tenant_isolation on ots_platform_links
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table ots_anomalies enable row level security;
drop policy if exists tenant_isolation on ots_anomalies;
create policy tenant_isolation on ots_anomalies
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table ots_anomaly_versions enable row level security;
drop policy if exists tenant_isolation on ots_anomaly_versions;
create policy tenant_isolation on ots_anomaly_versions
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table ots_anomaly_requirement_links enable row level security;
drop policy if exists tenant_isolation on ots_anomaly_requirement_links;
create policy tenant_isolation on ots_anomaly_requirement_links
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
