-- RLS for architecture ↔ requirement / test-case junction tables. Drizzle-generated
-- migrations/0018_architecture_links.sql creates the tables and FKs; this file adds the
-- tenant isolation policies (same split as every other manual migration).

alter table architecture_node_requirement_links enable row level security;
drop policy if exists tenant_isolation on architecture_node_requirement_links;
create policy tenant_isolation on architecture_node_requirement_links
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table architecture_node_test_case_links enable row level security;
drop policy if exists tenant_isolation on architecture_node_test_case_links;
create policy tenant_isolation on architecture_node_test_case_links
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
