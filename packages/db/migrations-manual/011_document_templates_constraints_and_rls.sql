-- Backlog item 9.29: user-definable PDF document templates. Same split as every other
-- manual migration in this directory: the CHECK constraints and RLS policies
-- migrations/0013_document_templates.sql (drizzle-generated) can't emit.

-- --- Fixed, code-understood value sets, enforced as CHECK constraints ------------------

alter table document_templates drop constraint if exists document_templates_scope_check;
alter table document_templates add constraint document_templates_scope_check
  check (scope in ('test_case', 'test_execution', 'requirement_list'));

alter table document_template_parameters drop constraint if exists document_template_parameters_type_check;
alter table document_template_parameters add constraint document_template_parameters_type_check
  check (type in ('text', 'date'));

-- A parameter's key is what the template body actually references as {{params.<key>}} -
-- keep it to what's safe inside a Handlebars path expression with no quoting, matching
-- the validation packages/core/src/document-templates.ts already enforces before insert
-- (belt and suspenders, same reasoning as every other CHECK in this project mirroring an
-- application-level validation).
alter table document_template_parameters drop constraint if exists document_template_parameters_key_check;
alter table document_template_parameters add constraint document_template_parameters_key_check
  check (key ~ '^[a-zA-Z][a-zA-Z0-9_]*$');

-- --- Row Level Security ---------------------------------------------------------------
-- Same reasoning as every prior manual migration: plain ENABLE (not FORCE) - app_runtime
-- never owns these tables, and galm_migrator (the owner) needs unrestricted access for
-- admin/seed/backfill work.

alter table document_templates enable row level security;
drop policy if exists tenant_isolation on document_templates;
create policy tenant_isolation on document_templates
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table document_template_parameters enable row level security;
drop policy if exists tenant_isolation on document_template_parameters;
create policy tenant_isolation on document_template_parameters
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
