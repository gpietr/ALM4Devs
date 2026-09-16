-- Backlog item 8: Spira importer connection storage. Same RLS pattern as 003
-- (tenant_settings) - one row per tenant, primary key is the tenant id itself.

alter table spira_connections enable row level security;
drop policy if exists tenant_isolation on spira_connections;
create policy tenant_isolation on spira_connections
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
