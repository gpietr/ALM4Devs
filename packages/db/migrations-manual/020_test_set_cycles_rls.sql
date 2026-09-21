-- Test set cycles: one pass through a test set (e.g. "Release 1.2"), so re-running the
-- same set over time doesn't blend one release's results into the next. Drizzle-generated
-- migrations/0028_test_set_cycles.sql creates the table and FKs; this file adds the RLS
-- that drizzle-kit can't emit, same split as every other manual migration here.

alter table test_set_cycles enable row level security;
drop policy if exists tenant_isolation on test_set_cycles;
create policy tenant_isolation on test_set_cycles
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
