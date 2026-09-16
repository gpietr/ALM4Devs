-- LLM-assisted test step drafting: per-tenant LLM connection storage. Same split as
-- every other manual migration in this directory: the CHECK constraint and RLS policy
-- migrations/0015_tired_nuke.sql (drizzle-generated) can't emit.

-- --- Fixed, code-understood value set, enforced as a CHECK constraint -----------------

alter table llm_connections drop constraint if exists llm_connections_provider_check;
alter table llm_connections add constraint llm_connections_provider_check
  check (provider in ('anthropic', 'openai', 'openai_compatible'));

-- No CHECK here requiring base_url when provider = 'openai_compatible' - that invariant
-- lives in packages/core/src/llm-connection.ts's saveLlmConnection, same as every other
-- application-level-only invariant in this project (e.g. spira_connections has no CHECK
-- forcing a non-empty api_key either - that's enforced in saveSpiraConnection).

-- --- Row Level Security ---------------------------------------------------------------
-- Same reasoning as every prior manual migration: plain ENABLE (not FORCE) - app_runtime
-- never owns this table, and galm_migrator (the owner) needs unrestricted access.

alter table llm_connections enable row level security;
drop policy if exists tenant_isolation on llm_connections;
create policy tenant_isolation on llm_connections
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
