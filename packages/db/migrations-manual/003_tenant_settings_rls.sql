-- Backlog: settings (optional e-signature, independent review, status management).
-- Same RLS pattern as 002 - plain ENABLE, not FORCE (see that file's note on why).

alter table tenant_settings enable row level security;
drop policy if exists tenant_isolation on tenant_settings;
create policy tenant_isolation on tenant_settings
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
