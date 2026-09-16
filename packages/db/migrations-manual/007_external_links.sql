-- Generic "imported from an external system" mapping (requirements + test cases/steps for
-- now, Spira's the only source). See packages/db/src/schema.ts's externalLinks docstring.

alter table external_links drop constraint if exists external_links_entity_type_check;
alter table external_links add constraint external_links_entity_type_check
  check (entity_type in ('requirement', 'test_case', 'test_step'));

alter table external_links drop constraint if exists external_links_source_check;
alter table external_links add constraint external_links_source_check
  check (source in ('spira'));

alter table external_links enable row level security;
drop policy if exists tenant_isolation on external_links;
create policy tenant_isolation on external_links
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
