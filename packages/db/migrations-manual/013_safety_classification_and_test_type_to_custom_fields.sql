-- Safety Classification (requirements) and Test Type (test cases) were dedicated,
-- hardcoded columns - both become ordinary tenant-defined custom fields (see
-- packages/core/src/custom-fields.ts's seedDefaultCustomFields, which seeds the same two
-- fields for every NEW tenant going forward, via /api/register). This migration does the
-- one-time work for every EXISTING tenant: seed the field + option rows, backfill a value
-- row for every requirement/test case that had the old column set, then drop the old
-- columns. Runs exactly once, ever (see packages/db/src/migrate.ts) - safe to write
-- straight-line, no "insert if not already seeded" guards needed, only the usual
-- `drop ... if exists` hygiene already used everywhere else in this directory.
--
-- The corresponding schema.ts columns are removed in the same commit as this file, NOT
-- via a Drizzle-generated migration - Drizzle's generator has no way to know a dropped
-- column's data needs to move into a different table first, so the column drop only
-- happens here, after the backfill below, in one transaction with it.

-- --- Seed the two field definitions, one per tenant ------------------------------------

insert into custom_field_definitions (id, tenant_id, entity_type, name, field_type, is_required, sort_order, created_at)
select
  gen_random_uuid(),
  t.id,
  'requirement',
  'Safety Classification',
  'list',
  false,
  coalesce((select max(sort_order) + 1 from custom_field_definitions cfd where cfd.tenant_id = t.id and cfd.entity_type = 'requirement'), 0),
  now()
from tenants t;

insert into custom_field_definitions (id, tenant_id, entity_type, name, field_type, is_required, sort_order, created_at)
select
  gen_random_uuid(),
  t.id,
  'test_case',
  'Test Type',
  'list',
  true,
  coalesce((select max(sort_order) + 1 from custom_field_definitions cfd where cfd.tenant_id = t.id and cfd.entity_type = 'test_case'), 0),
  now()
from tenants t;

-- --- Seed each field's options ----------------------------------------------------------

insert into custom_field_list_options (id, tenant_id, field_id, value, sort_order, created_at)
select gen_random_uuid(), cfd.tenant_id, cfd.id, opt.value, opt.sort_order, now()
from custom_field_definitions cfd
cross join (values ('A', 0), ('B', 1), ('C', 2)) as opt(value, sort_order)
where cfd.entity_type = 'requirement' and cfd.name = 'Safety Classification';

insert into custom_field_list_options (id, tenant_id, field_id, value, sort_order, created_at)
select gen_random_uuid(), cfd.tenant_id, cfd.id, opt.value, opt.sort_order, now()
from custom_field_definitions cfd
cross join (values ('Verification', 0), ('Validation', 1)) as opt(value, sort_order)
where cfd.entity_type = 'test_case' and cfd.name = 'Test Type';

-- --- Backfill values from the old columns, before they're dropped below ----------------
-- Safety classification's old values ('A'/'B'/'C') match the new options' text exactly.
-- Test type's old values are lowercase ('verification'/'validation'); the new options are
-- capitalized for display, so the join is case-insensitive. test_cases.test_type was
-- NOT NULL, so every test case gets a value row here; requirements.safety_classification
-- was nullable, so only the ones that had one set do.

insert into custom_field_values (tenant_id, field_id, entity_id, value)
select r.tenant_id, cfd.id, r.id, cflo.id
from requirements r
join custom_field_definitions cfd on cfd.tenant_id = r.tenant_id and cfd.entity_type = 'requirement' and cfd.name = 'Safety Classification'
join custom_field_list_options cflo on cflo.field_id = cfd.id and cflo.value = r.safety_classification
where r.safety_classification is not null;

insert into custom_field_values (tenant_id, field_id, entity_id, value)
select tc.tenant_id, cfd.id, tc.id, cflo.id
from test_cases tc
join custom_field_definitions cfd on cfd.tenant_id = tc.tenant_id and cfd.entity_type = 'test_case' and cfd.name = 'Test Type'
join custom_field_list_options cflo on cflo.field_id = cfd.id and lower(cflo.value) = tc.test_type;

-- --- Drop the old columns and their CHECK constraints -----------------------------------

alter table requirements drop constraint if exists requirements_safety_classification_check;
alter table requirements drop column if exists safety_classification;

alter table test_cases drop constraint if exists test_cases_test_type_check;
alter table test_cases drop column if exists test_type;
