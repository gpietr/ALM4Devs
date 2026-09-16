-- Backlog item 2: constraints, RLS, and approval-event immutability for the domain model
-- (Product/Requirement/status/approval). Idempotent, same pattern as 001.

-- --- Fixed, regulatory/code-understood value sets, enforced as CHECK constraints ------
-- These are deliberately NOT customizable (unlike requirement_statuses.category's meaning
-- below) - type and safety classification are IEC 62304 concepts, not team preference.

alter table requirement_statuses drop constraint if exists requirement_statuses_category_check;
alter table requirement_statuses add constraint requirement_statuses_category_check
  check (category in ('draft', 'in_review', 'approved', 'baselined'));

alter table requirements drop constraint if exists requirements_type_check;
alter table requirements add constraint requirements_type_check
  check (type in ('user_need', 'system_requirement', 'software_item_spec'));

alter table requirements drop constraint if exists requirements_safety_classification_check;
alter table requirements add constraint requirements_safety_classification_check
  check (safety_classification is null or safety_classification in ('A', 'B', 'C'));

alter table approval_events drop constraint if exists approval_events_entity_type_check;
alter table approval_events add constraint approval_events_entity_type_check
  check (entity_type in ('requirement_version'));

-- A tenant may rename or disable a status, but never end up with two active statuses in
-- the same category with the same name, and a given (tenant, category, name) is unique
-- regardless of enabled state so a disabled status can't collide with a re-added one.
alter table requirement_statuses drop constraint if exists requirement_statuses_tenant_name_unique;
alter table requirement_statuses add constraint requirement_statuses_tenant_name_unique
  unique (tenant_id, name);

-- --- Row Level Security ---------------------------------------------------------------
-- Same reasoning as 001: plain ENABLE (not FORCE) is enough since app_runtime never owns
-- these tables; galm_migrator (the owner) needs unrestricted access for admin/seed work.

alter table products enable row level security;
drop policy if exists tenant_isolation on products;
create policy tenant_isolation on products
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table requirement_statuses enable row level security;
drop policy if exists tenant_isolation on requirement_statuses;
create policy tenant_isolation on requirement_statuses
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table requirements enable row level security;
drop policy if exists tenant_isolation on requirements;
create policy tenant_isolation on requirements
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table requirement_versions enable row level security;
drop policy if exists tenant_isolation on requirement_versions;
create policy tenant_isolation on requirement_versions
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table approval_events enable row level security;
drop policy if exists tenant_isolation on approval_events;
create policy tenant_isolation on approval_events
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- reauth_token_uses is deliberately NOT tenant-scoped/RLS'd - it's a global, opaque
-- replay-prevention ledger keyed by token jti, not tenant business data.

-- --- Approval/e-signature log immutability --------------------------------------------
-- Same belt-and-suspenders pattern as audit_log in 001. reject_audit_log_mutation() only
-- references OLD.id, which every immutable-ledger table here has, so it's reused as-is
-- rather than duplicated per table.

revoke update, delete on approval_events from app_runtime;

drop trigger if exists approval_events_immutable on approval_events;
create trigger approval_events_immutable
  before update or delete on approval_events
  for each row execute function reject_audit_log_mutation();

create or replace function approval_event_set_hash() returns trigger as $$
declare
  last_hash text;
begin
  perform pg_advisory_xact_lock(hashtext('approval_events_hash_chain'));
  select row_hash into last_hash from approval_events order by created_at desc, id desc limit 1;
  new.prev_hash := last_hash;
  new.row_hash := encode(
    digest(
      new.tenant_id::text || '|' ||
      new.entity_type || '|' || new.entity_id::text || '|' ||
      coalesce(new.from_status_id::text, '') || '|' || new.to_status_id::text || '|' ||
      new.actor_user_id || '|' || new.typed_name || '|' || new.reauth_at::text || '|' ||
      coalesce(last_hash, ''),
      'sha256'
    ),
    'hex'
  );
  return new;
end;
$$ language plpgsql;

drop trigger if exists approval_events_hash_chain on approval_events;
create trigger approval_events_hash_chain
  before insert on approval_events
  for each row execute function approval_event_set_hash();
