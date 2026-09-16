-- Requirement hierarchy: user-definable levels replacing the old fixed 'type' enum.
-- Idempotent, same pattern as 001-003. Handles both fresh installs (no requirements rows
-- yet, the seed/backfill touch nothing) and the existing dev database (real `type` data
-- that needs mapping to the new per-tenant level rows before `type` can be dropped).

-- --- Row Level Security --------------------------------------------------------------
alter table requirement_levels enable row level security;
drop policy if exists tenant_isolation on requirement_levels;
create policy tenant_isolation on requirement_levels
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table requirement_levels drop constraint if exists requirement_levels_tenant_name_unique;
alter table requirement_levels add constraint requirement_levels_tenant_name_unique
  unique (tenant_id, name);

-- --- Seed default levels for every tenant that doesn't have any yet -------------------
-- (every tenant on a fresh install; only pre-existing tenants on an upgrade, since new
-- ones get seeded by /api/register the same way requirement_statuses is.)
insert into requirement_levels (tenant_id, name, sort_order)
select t.id, v.name, v.sort_order
from tenants t
cross join (values ('User Need', 0), ('System Requirement', 1), ('Software Item Spec', 2)) as v(name, sort_order)
where not exists (select 1 from requirement_levels rl where rl.tenant_id = t.id);

-- --- Backfill level_id on existing requirements from the old `type` column ------------
-- Every row that predates this migration was created under the fixed 3-type model, so
-- this name mapping is exact - not a guess - for all of them.
update requirements r
set level_id = rl.id
from requirement_levels rl
where r.level_id is null
  and rl.tenant_id = r.tenant_id
  and rl.name = case r.type
    when 'user_need' then 'User Need'
    when 'system_requirement' then 'System Requirement'
    when 'software_item_spec' then 'Software Item Spec'
  end;

-- --- Now safe to require it and drop the old fixed-enum column -----------------------
alter table requirements alter column level_id set not null;
alter table requirements drop constraint if exists requirements_type_check;
alter table requirements drop column if exists type;
