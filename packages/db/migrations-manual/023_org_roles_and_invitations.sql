-- Org roles (admin/member), a flat cross-tenant system-admin flag, tenant suspension, and
-- the invitations table backing the hand-rolled invite-a-teammate flow (see
-- apps/web/src/server/routers/members.ts). The columns/table themselves were added by the
-- drizzle-generated migration immediately before this one (packages/db/src/migrate.ts runs
-- drizzle migrations first, then migrations-manual/*.sql by filename) - this file adds the
-- CHECK constraints Drizzle's schema DSL can't express, plus RLS, same split as every other
-- manual migration here.

alter table "user" drop constraint if exists user_role_check;
alter table "user" add constraint user_role_check check (role in ('admin', 'member'));

alter table invitations drop constraint if exists invitations_role_check;
alter table invitations add constraint invitations_role_check check (role in ('admin', 'member'));

alter table invitations drop constraint if exists invitations_status_check;
alter table invitations add constraint invitations_status_check check (status in ('pending', 'accepted', 'revoked'));

-- Same tenant_isolation pattern as every other business table - see 003_tenant_settings_rls.sql.
alter table invitations enable row level security;
drop policy if exists tenant_isolation on invitations;
create policy tenant_isolation on invitations
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- --- One-time backfill -----------------------------------------------------------------
-- Every existing tenant currently has zero admins (the role concept didn't exist before
-- this migration; every existing row got the 'member' default from the migration just
-- before this one). Without this, nobody in an already-registered tenant could ever
-- invite/manage members - orgAdminProcedure checks role='admin' and there is no other
-- bootstrap path (scripts/set-system-admin.ts only sets the unrelated cross-tenant flag).
-- Promote each tenant's earliest-created, not-yet-removed user to admin. Runs exactly once
-- (packages/db/src/migrate.ts tracks manual migrations by filename) - safe to write
-- straight-line, same convention as migration 022's one-time backfill.
with first_user as (
  select distinct on (tenant_id) id
  from "user"
  where removed_at is null
  order by tenant_id, created_at asc, id asc
)
update "user" set role = 'admin' where id in (select id from first_user);
