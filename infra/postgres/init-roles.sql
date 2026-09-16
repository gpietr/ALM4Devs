-- Runs once, automatically, on first container start (postgres image convention:
-- anything in /docker-entrypoint-initdb.d executes against a fresh data directory only).
--
-- Two roles, matching TECH_STACK.md's two-role model:
--   galm_migrator - owns the schema, runs DDL/migrations, bypasses RLS. Never used by the
--                   running app, only by the one-shot `migrate` service/command.
--   app_runtime   - the only credential apps/web and apps/worker ever connect as. RLS-bound,
--                   no DDL rights, and (as of Postgres default) NOBYPASSRLS - stated
--                   explicitly below so it can't be silently granted later without it
--                   showing up in a diff of this file.

create role galm_migrator with login password 'migrator_dev_password' createrole;
alter database galm owner to galm_migrator;

create role app_runtime with login password 'app_runtime_dev_password' nosuperuser nocreatedb nocreaterole nobypassrls;
grant connect on database galm to app_runtime;

-- galm_migrator needs to be able to grant privileges to app_runtime on objects it creates;
-- default privileges ensure every future table/sequence created by galm_migrator is
-- automatically readable/writable by app_runtime without a manual GRANT per migration.
alter default privileges for role galm_migrator in schema public
  grant select, insert, update, delete on tables to app_runtime;
alter default privileges for role galm_migrator in schema public
  grant usage, select on sequences to app_runtime;

-- pg-boss gets its own schema, fully owned by app_runtime, so the job queue library can
-- self-manage its schema (create/upgrade its own tables on `boss.start()`) without
-- app_runtime needing any DDL rights over the actual business/audit schema in `public`.
-- Job-queue metadata isn't tenant/audit-sensitive data, so owning this one schema outright
-- is a deliberate, narrow exception to "app_runtime has no DDL rights."
create schema if not exists pgboss authorization app_runtime;

-- Learned by actually running this: pg-boss's own startup migration issues an idempotent
-- `CREATE SCHEMA IF NOT EXISTS pgboss` every time it connects, regardless of whether the
-- schema already exists above. Postgres checks CREATE-on-database privilege before it
-- checks whether the schema already exists, so without this grant the statement fails
-- with "permission denied for database" even though nothing would actually be created.
-- This does NOT let app_runtime create objects inside `public` (that needs CREATE on the
-- schema itself, never granted) - only new schemas, which in practice means only pg-boss's
-- own idempotent startup check succeeds.
grant create on database galm to app_runtime;
