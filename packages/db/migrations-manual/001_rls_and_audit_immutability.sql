-- Hand-written SQL, applied by migrate.ts after drizzle-kit's generated migrations create
-- the tables. Kept separate from drizzle's own migrations/ folder because drizzle-kit
-- only understands table/column DDL it generated itself, not RLS policies, roles, or
-- triggers - those need to be reviewed and run as their own explicit step. Idempotent:
-- safe to re-run (used both on first migrate and on every subsequent one).

create extension if not exists pgcrypto;

-- --- Row Level Security --------------------------------------------------------------
-- current_setting(..., true) returns NULL rather than erroring when app.tenant_id was
-- never SET LOCAL for the session - and tenant_id = NULL is never true, so a request that
-- forgets to set the tenant context is default-denied, not accidentally granted everything.
--
-- Deliberately NOT applied to "user"/"session"/"account"/"verification": better-auth's
-- login flow looks a user up by email *before* any tenant context exists (that lookup is
-- how the tenant is determined in the first place), so those tables are scoped by
-- ordinary foreign-key/application-level checks instead of request-time RLS.
--
-- Deliberately NOT using FORCE ROW LEVEL SECURITY, correcting the original TECH_STACK.md
-- draft: galm_migrator (the DDL/migration-owner role) is the *owner* of these tables, and
-- FORCE would apply RLS to the owner too - which would then reject the seed script's
-- cross-tenant inserts below (a WITH CHECK derived from USING would require
-- current_setting('app.tenant_id') to already match, which an admin/seed/backfill
-- operation has no reason to set). Plain ENABLE already fully restricts app_runtime, which
-- is never the table owner - the two-role split does the job FORCE exists for, without
-- also blocking legitimate cross-tenant admin operations run as galm_migrator.

alter table items enable row level security;
drop policy if exists tenant_isolation on items;
create policy tenant_isolation on items
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table audit_log enable row level security;
drop policy if exists tenant_isolation on audit_log;
create policy tenant_isolation on audit_log
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- --- Audit log immutability ------------------------------------------------------------
-- Belt: the app's own DB credential is physically incapable of mutating history.
revoke update, delete on audit_log from app_runtime;

-- Suspenders: block even a superuser/incident-response session outright. Disabling this
-- trigger is itself a loud, auditable DDL action - unlike silently allowing an UPDATE.
create or replace function reject_audit_log_mutation() returns trigger as $$
begin
  raise exception 'audit_log is append-only: % is not permitted (row id %)', tg_op, old.id;
end;
$$ language plpgsql;

drop trigger if exists audit_log_immutable on audit_log;
create trigger audit_log_immutable
  before update or delete on audit_log
  for each row execute function reject_audit_log_mutation();

-- --- Hash chain --------------------------------------------------------------------
-- Serialized with a transaction-scoped advisory lock so concurrent inserts can't race on
-- prev_hash. This function has no SECURITY DEFINER, so its own SELECT runs under RLS just
-- like any other query from the calling role - which means the chain it builds is
-- effectively *per-tenant*, not global across the whole table, even though nothing here
-- filters by tenant_id explicitly. That's the right scope, not a shortcut: a genuinely
-- global chain would need SECURITY DEFINER to read across tenants, and would then be
-- unverifiable by any single tenant anyway, since RLS means they can never read another
-- tenant's rows to confirm the linkage. Each tenant's own history is independently
-- tamper-evident, which is what actually matters here.
create or replace function audit_log_set_hash() returns trigger as $$
declare
  last_hash text;
begin
  perform pg_advisory_xact_lock(hashtext('audit_log_hash_chain'));
  select row_hash into last_hash from audit_log order by created_at desc, id desc limit 1;
  new.prev_hash := last_hash;
  new.row_hash := encode(
    digest(
      coalesce(new.tenant_id::text, '') || '|' ||
      coalesce(new.actor_user_id, '') || '|' ||
      new.action || '|' || new.entity_type || '|' || new.entity_id || '|' ||
      coalesce(new.payload::text, '') || '|' ||
      coalesce(last_hash, ''),
      'sha256'
    ),
    'hex'
  );
  return new;
end;
$$ language plpgsql;

drop trigger if exists audit_log_hash_chain on audit_log;
create trigger audit_log_hash_chain
  before insert on audit_log
  for each row execute function audit_log_set_hash();
