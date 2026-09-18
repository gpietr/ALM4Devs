-- NVD vulnerability scanning for OTS architecture items. Drizzle-generated
-- migrations/0020_groovy_ironclad.sql creates the tables, the new architecture_nodes.cpe
-- column, and FKs; this file adds the CHECKs and RLS that drizzle-kit can't emit (same
-- split as every other manual migration in this directory).

-- --- Fixed, code-understood value sets, enforced as CHECK constraints -----------------

alter table vulnerability_scans drop constraint if exists vulnerability_scans_match_type_check;
alter table vulnerability_scans add constraint vulnerability_scans_match_type_check
  check (match_type in ('cpe', 'keyword'));

alter table vulnerability_scans drop constraint if exists vulnerability_scans_status_check;
alter table vulnerability_scans add constraint vulnerability_scans_status_check
  check (status in ('completed', 'failed'));

-- vulnerability_annotations originally had a single enum `status` column here
-- ('affects_product' | 'false_positive'), CHECK-constrained the same way as above. It was
-- replaced by two independent boolean columns (migrations/0021_vulnerability_annotations_
-- toggles.sql) - a finding can be a real, non-false-positive CVE that still doesn't affect
-- this product, which the single enum couldn't represent. Booleans don't need a CHECK.

-- --- Row Level Security ---------------------------------------------------------------
-- Same reasoning as every prior manual migration: plain ENABLE (not FORCE) - app_runtime
-- never owns these tables, and galm_migrator (the owner) needs unrestricted access.

alter table nvd_connections enable row level security;
drop policy if exists tenant_isolation on nvd_connections;
create policy tenant_isolation on nvd_connections
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table vulnerability_scans enable row level security;
drop policy if exists tenant_isolation on vulnerability_scans;
create policy tenant_isolation on vulnerability_scans
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table vulnerability_findings enable row level security;
drop policy if exists tenant_isolation on vulnerability_findings;
create policy tenant_isolation on vulnerability_findings
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table vulnerability_annotations enable row level security;
drop policy if exists tenant_isolation on vulnerability_annotations;
create policy tenant_isolation on vulnerability_annotations
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
