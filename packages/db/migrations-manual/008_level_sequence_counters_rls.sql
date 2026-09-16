-- Sequential per-(product, level) human-readable ids (SYSREQ-1, SYSREQ-2, ...) - see
-- packages/db/src/schema.ts's levelSequenceCounters docstring.

alter table level_sequence_counters enable row level security;
drop policy if exists tenant_isolation on level_sequence_counters;
create policy tenant_isolation on level_sequence_counters
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
