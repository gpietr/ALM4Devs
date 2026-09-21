-- Environment used to be a dedicated table (test_environments) + a required FK column on
-- test_executions and an optional one on test_set_items, forcing exactly one specific
-- parameter before a run could start. It's an ordinary "test run" custom field now (see
-- packages/core/src/custom-fields.ts's seedDefaultCustomFields, which seeds the same field
-- for every NEW tenant going forward) - a tenant can rename it, add options, make it
-- optional, or delete it outright exactly like any other field, instead of being stuck
-- with a column the app forced on every run. This migration does the one-time work for
-- every EXISTING tenant: seed the field + each tenant's own environment names as its
-- options, backfill a value row for every execution/test-set-item that had the old column
-- set, then drop the old columns and the table itself. Runs exactly once, ever (see
-- packages/db/src/migrate.ts) - safe to write straight-line, no "insert if not already
-- seeded" guards needed, only the usual `drop ... if exists` hygiene already used
-- everywhere else in this directory.
--
-- The corresponding schema.ts columns/table are removed in the same commit as this file,
-- NOT via a Drizzle-generated migration - Drizzle's generator has no way to know a dropped
-- column's data needs to move into a different table first, so the drop only happens here,
-- after the backfill below, in one transaction with it. Same shape as migration 013
-- (Safety Classification/Test Type's identical move off dedicated columns).

-- --- Seed one "Environment" field per tenant, appended after any test_run fields a
-- --- tenant already has (test_set_items' own custom parameters already used this
-- --- entityType before this migration) ------------------------------------------------

insert into custom_field_definitions (id, tenant_id, entity_type, name, field_type, is_required, sort_order, created_at)
select
  gen_random_uuid(),
  t.id,
  'test_run',
  'Environment',
  'list',
  true,
  coalesce((select max(sort_order) + 1 from custom_field_definitions cfd where cfd.tenant_id = t.id and cfd.entity_type = 'test_run'), 0),
  now()
from tenants t;

-- --- Seed each tenant's own environment names as that field's options, preserving order -

insert into custom_field_list_options (id, tenant_id, field_id, value, sort_order, created_at)
select gen_random_uuid(), te.tenant_id, cfd.id, te.name, te.sort_order, now()
from test_environments te
join custom_field_definitions cfd on cfd.tenant_id = te.tenant_id and cfd.entity_type = 'test_run' and cfd.name = 'Environment';

-- --- Backfill values from the old columns, before they're dropped below --------------
-- test_executions.environment_id was NOT NULL, so every execution gets a value row here;
-- test_set_items.environment_id was nullable, so only the ones that had one set do.

insert into custom_field_values (tenant_id, field_id, entity_id, value)
select ex.tenant_id, cfd.id, ex.id, cflo.id
from test_executions ex
join custom_field_definitions cfd on cfd.tenant_id = ex.tenant_id and cfd.entity_type = 'test_run' and cfd.name = 'Environment'
join custom_field_list_options cflo on cflo.field_id = cfd.id and cflo.value = (select name from test_environments where id = ex.environment_id);

insert into custom_field_values (tenant_id, field_id, entity_id, value)
select tsi.tenant_id, cfd.id, tsi.id, cflo.id
from test_set_items tsi
join custom_field_definitions cfd on cfd.tenant_id = tsi.tenant_id and cfd.entity_type = 'test_run' and cfd.name = 'Environment'
join custom_field_list_options cflo on cflo.field_id = cfd.id and cflo.value = (select name from test_environments where id = tsi.environment_id)
where tsi.environment_id is not null;

-- --- Drop the old columns/constraints, then the table itself --------------------------

alter table test_executions drop column if exists environment_id;
alter table test_set_items drop column if exists environment_id;
drop table if exists test_environments;
