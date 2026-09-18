-- OTS version history. Drizzle-generated migrations/0022_architecture_node_versions.sql
-- creates the table and FKs; this file adds the tenant-isolation RLS policy (same split as
-- every other manual migration in this directory). No CHECK constraints needed - unlike
-- vulnerability_scans/vulnerability_annotations, nothing here is a fixed enum.

alter table architecture_node_versions enable row level security;
drop policy if exists tenant_isolation on architecture_node_versions;
create policy tenant_isolation on architecture_node_versions
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
