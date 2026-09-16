-- Backlog item 4: test levels/environments, test cases/steps, executions, attachments.
-- Same RLS + CHECK-constraint pattern as 002/003/004.

-- --- Fixed, code-understood value sets, enforced as CHECK constraints -----------------

alter table test_cases drop constraint if exists test_cases_test_type_check;
alter table test_cases add constraint test_cases_test_type_check
  check (test_type in ('verification', 'validation'));

alter table test_executions drop constraint if exists test_executions_status_check;
alter table test_executions add constraint test_executions_status_check
  check (status in ('in_progress', 'pass', 'fail', 'blocked'));

alter table test_step_executions drop constraint if exists test_step_executions_status_check;
alter table test_step_executions add constraint test_step_executions_status_check
  check (status in ('not_run', 'pass', 'fail', 'blocked'));

-- A tenant may rename a level/environment, but never end up with two active ones sharing
-- a name - same reasoning as requirement_statuses/requirement_levels.
alter table test_levels drop constraint if exists test_levels_tenant_name_unique;
alter table test_levels add constraint test_levels_tenant_name_unique unique (tenant_id, name);

alter table test_environments drop constraint if exists test_environments_tenant_name_unique;
alter table test_environments add constraint test_environments_tenant_name_unique
  unique (tenant_id, name);

-- --- Row Level Security ---------------------------------------------------------------
-- Same reasoning as prior manual migrations: plain ENABLE (not FORCE) - app_runtime never
-- owns these tables, and galm_migrator (the owner) needs unrestricted access for
-- admin/seed/backfill work.

alter table test_levels enable row level security;
drop policy if exists tenant_isolation on test_levels;
create policy tenant_isolation on test_levels
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table test_environments enable row level security;
drop policy if exists tenant_isolation on test_environments;
create policy tenant_isolation on test_environments
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table test_cases enable row level security;
drop policy if exists tenant_isolation on test_cases;
create policy tenant_isolation on test_cases
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table test_steps enable row level security;
drop policy if exists tenant_isolation on test_steps;
create policy tenant_isolation on test_steps
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table test_case_requirement_links enable row level security;
drop policy if exists tenant_isolation on test_case_requirement_links;
create policy tenant_isolation on test_case_requirement_links
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table test_step_requirement_links enable row level security;
drop policy if exists tenant_isolation on test_step_requirement_links;
create policy tenant_isolation on test_step_requirement_links
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table test_executions enable row level security;
drop policy if exists tenant_isolation on test_executions;
create policy tenant_isolation on test_executions
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table test_step_executions enable row level security;
drop policy if exists tenant_isolation on test_step_executions;
create policy tenant_isolation on test_step_executions
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table attachments enable row level security;
drop policy if exists tenant_isolation on attachments;
create policy tenant_isolation on attachments
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
