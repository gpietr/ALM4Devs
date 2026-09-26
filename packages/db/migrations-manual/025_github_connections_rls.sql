-- GitHub issue import for OTS known issues. migrations/0032_github_connections.sql creates
-- the table and FK; this file adds the RLS drizzle-kit can't emit.

alter table github_connections enable row level security;
drop policy if exists tenant_isolation on github_connections;
create policy tenant_isolation on github_connections
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
