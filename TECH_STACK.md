# Tech Stack & Architecture

## Context

`PRODUCT.md` defines the product (open-source-first requirements/test management tool for
early-stage SaMD teams, AGPL-3.0 core, self-hostable + hosted SaaS) but left the technical
stack, repo boundary, and integration architecture open. This document settles the
foundational, hard-to-reverse technical decisions before implementation starts, so that
feature work (requirements/test authoring, traceability matrix, Jira/Spira integrations) is
built on a stack and structure that won't need to be re-architected later.

Three decisions anchor everything below:
1. **Full TypeScript stack, Bun as the runtime everywhere** — not just tooling, but the
   actual production app and background workers.
2. **Fully open source for now** — single AGPL-3.0 repo, no proprietary/license-gated module
   layer yet. Structure leaves room to add one later without a rewrite, but the gating
   mechanism itself isn't built now.
3. **Hosted SaaS multi-tenancy: shared Postgres database, row-level tenant isolation**
   (tenant_id + Postgres RLS as defense-in-depth behind app-level scoping).

## Architecture

### 1. Runtime & framework
- **Bun** runs everything: `apps/web` (Next.js App Router), `apps/worker` (background jobs),
  package management, and tests. Next.js has official Bun runtime support; Bun's npm
  compatibility is high but concentrated risk is in packages with native C/C++ addons — the
  choices below are made specifically to avoid those.
- **API layer**: tRPC for the internal web app (end-to-end type safety, pairs with TanStack
  Query). Plain Next.js Route Handlers (REST/JSON) for anything external: the Jira webhook
  receiver, OAuth callbacks, and any future public API — built on the same Zod schemas tRPC
  already uses, so validation isn't duplicated.

### 2. Database & ORM
- **PostgreSQL + Drizzle ORM**, using Drizzle's `bun-sql` driver on Bun's native Postgres
  client. Drizzle has no native binary (unlike Prisma's Rust query engine), which matters
  under a full-Bun bet.
- **Tenant isolation**: every tenant-scoped table carries an indexed `tenant_id`, with
  `ENABLE ROW LEVEL SECURITY` and a policy keyed on `current_setting('app.tenant_id')`, set
  via `SET LOCAL` from the authenticated session at the start of each request — never from
  client input. This is a second lock behind an app-level repository layer that always
  filters by `tenant_id` explicitly; treat both as required, not either/or. Two DB roles: a
  migration-owner role (`galm_migrator`, DDL rights, owns the tables) and a least-privilege
  `app_runtime` role the app actually connects as (RLS-bound, no DDL rights).
  Deliberately **not** using `FORCE ROW LEVEL SECURITY` (an earlier draft of this doc called
  for it): `galm_migrator` owns the tables, and FORCE applies RLS to the owner too, which
  would block legitimate admin/seed/backfill operations run as that role. Plain `ENABLE`
  already fully restricts `app_runtime` since it is never the table owner — the two-role
  split does the job FORCE exists for, without the side effect. FORCE would only be needed
  if the app itself ever connected as the owning role, which this design specifically avoids.
- **Audit Log & Approval/E-signature immutability**: `REVOKE UPDATE, DELETE` on both tables
  from `app_runtime`, plus a `BEFORE UPDATE OR DELETE` trigger that unconditionally raises —
  so the app's own credential is physically incapable of rewriting history, and even an
  incident-response superuser session is blocked without a loud, auditable step (disabling
  the trigger). Corrections are new rows (`superseded_by`/`reason_for_correction`), never
  UPDATE.
- **Hash-chain on audit/approval rows**: build this in from day one —
  `row_hash = SHA256(fields + prev_hash)` computed in the same insert trigger. Near-zero cost
  now, effectively impossible to retrofit onto historical data later, and turns "immutable by
  policy" into "immutable and mechanically verifiable" — a real edge against Spira for
  eventual Part 11 readiness even though full Part 11 validation stays out of MVP scope.
- Requires the `pgcrypto` extension (ships with `postgres-contrib`) for the SHA-256 function
  backing the hash chain.

### 3. Background jobs & integrations
- **pg-boss** (Postgres-backed job queue) instead of BullMQ+Redis — runs on the Postgres
  instance already required, so self-host `docker-compose.yml` needs no extra service for
  queuing. Its throughput ceiling is far beyond this product's actual job volume. Hide it
  behind a small `enqueue()/registerWorker()` interface in `packages/core` so a future
  Redis-backed swap is additive, not a rewrite.
- **Jira sync** (`packages/integrations/jira`): webhook receiver (thin, fast, just validates
  and enqueues) **plus** a genuine polling reconciliation job, not just a Data-Center
  fallback — Jira Data Center webhooks have no retry mechanism, so a dropped delivery is lost
  permanently without polling as a backstop. One shared sync/mapping code path serves both
  triggers.
- **Spira importer** (`packages/integrations/spira`): one-time job, not persistent sync.
  Client tries Spira's REST API first, falls back to the legacy SOAP `ImportExport` service
  still present on older self-hosted instances (exactly this importer's target customers).
  Must be idempotent and support a dry-run/preview before commit, given how load-bearing
  existing traceability links are for a regulated customer.

### 4. File/evidence storage
Small storage interface (`putObject`/`getSignedUrl`/`deleteObject`) with two implementations:
a **local-filesystem driver** (default for self-host — files land on a mounted Docker volume,
"signed URLs" are a small token-checked route handler streaming from disk) and an **S3
driver** built on `Bun.S3Client` (Bun's native S3-protocol client, rather than the AWS SDK)
for hosted SaaS, pointed at R2/S3 directly. No object-storage service is required for
self-host — MinIO was considered and deliberately dropped: it's since pulled its web console
and other features out of the open-source/AGPL edition into a paid enterprise tier, a bad
dependency for a project whose whole pitch is open-source-first. Self-hosters who want the
S3 code path anyway (e.g. to point at their own bucket) can select the S3 driver via config;
nothing is hardcoded to local disk.

### 5. Traceability matrix export
**pdfmake** (pure-JS, declarative, built-in tables/pagination) for PDF, plain row-streaming
for CSV. Deliberately no Puppeteer/headless Chromium — it would add a heavy native-process
dependency to the self-host image for what is fundamentally tabular reporting, working
against the whole point of the Bun/native-binding-avoidance decisions.

### 6. Auth & e-signature
**better-auth** (TS-native, no native bindings, first-class Next.js support, plugin model)
over NextAuth — email/password + magic link at MVP, OIDC/SSO as an additive fast-follow, not
gated. Credential hashing via **`Bun.password`** (Bun's built-in argon2id) instead of native
bcrypt/argon2 addons.

**E-signature re-authentication** is a distinct, short-lived "signing assertion" separate
from the normal session: writing an Approval/E-signature event requires a fresh credential
check through a dedicated re-auth endpoint that mints a single-use, ~2-minute token bound to
`(user_id, timestamp, purpose)`. The approval-writing mutation requires and consumes this
token, and its issuance time becomes the e-signature timestamp. This composes cleanly with
SSO later since re-auth just defers to whichever provider is primary.

Whether this is actually *required* is a per-tenant setting (`tenant_settings.
require_esignature`), **off by default** - a tenant opts into it, it isn't forced on them.
A second, independent per-tenant setting (`require_independent_review`, also off by
default) blocks approving a requirement version you authored yourself, regardless of
whether e-signature is on - segregation of duties and "prove it's really you" are separate
concerns, so they're separate toggles. Both only ever apply to the "approved"/"baselined"
categories; see `packages/core/src/requirements.ts`'s `evaluateApprovalGate`.

**Auth tables are not under RLS.** better-auth's login flow looks a user up by email before
any tenant is known — that lookup is how the tenant gets determined in the first place — so
`user`/`session`/`account`/`verification` are scoped by ordinary application logic instead of
request-time RLS (which would otherwise reject the lookup outright, since no tenant context
exists yet to satisfy the policy). RLS applies to genuine tenant-owned business data
(`items` in the walking skeleton; Requirement/Test Case/etc. from backlog item 1 on).

### 7. Repo structure
Single AGPL-3.0 repo, Bun workspaces (Turborepo only if build times later warrant it):

```
apps/
  web/                    - Next.js on Bun: UI, tRPC router, REST/webhook route handlers
  worker/                 - Bun process: pg-boss job handlers (jira sync, spira import, pdf export, email)
packages/
  db/                     - Drizzle schema, migrations, RLS policies, typed repository layer
  core/                   - Framework-agnostic domain logic: req/test/approval state machines, traceability computation, permissions
  auth/                   - better-auth config, session + re-auth/e-signature token logic
  storage/                - File storage abstraction: local-filesystem driver (self-host default) + Bun.S3Client S3 driver (hosted)
  export/                 - pdfmake-based traceability matrix PDF/CSV rendering
  integrations/jira/      - Jira Cloud + Data Center client, webhook parsing, bidirectional sync
  integrations/spira/     - Spira REST/SOAP client + one-time importer
  ui/                     - Shared React components (shadcn/ui-based)
  config/                 - Shared tsconfig/eslint/tailwind presets
```

Future proprietary layer (not built now): keep `packages/core`/`packages/db` licensing-agnostic
so a later `packages/ee` or separate private repo can depend on them as versioned workspace
packages to add SSO/SAML, a Part-11 package, retention policies, etc. additively.

### 8. Deployment
- **Self-host `docker-compose.yml`** (required services only): `web`, `worker`, `postgres` —
  three services, no object-storage container needed since evidence files default to a
  mounted volume via the local-filesystem storage driver. No Redis, no separate cache tier
  either — a deliberate differentiator against Spira/Ketryx-style installs.
- **Hosted SaaS**: `web` and `worker` split into independently scaled deployments (web scales
  on request concurrency, worker on pg-boss backlog depth). Managed Postgres with
  point-in-time-recovery backups (this doubles as the audit trail of record). Managed
  S3-compatible storage (R2/S3) via the storage abstraction's S3 driver.
- **Hosting platform: Fly.io or Render over raw AWS** — both give Docker-native deploys where
  the self-host image doubles as the SaaS artifact, managed Postgres without IAM/VPC/ALB
  overhead, and match a small bootstrapped team's actual ops capacity.

### 9. Frontend
Next.js App Router + Tailwind + **shadcn/ui** (no runtime dependency, fits the Linear/Qase
aesthetic bar named in the product doc). Data-fetching via tRPC + TanStack Query, giving
end-to-end type safety from `packages/db` through `packages/core` into components — reduces
a whole bug class in exactly the feature that's the product's core differentiator (the
traceability matrix always being correct). Load the `frontend-design` skill when real UI work
starts.

## Learnings from building and verifying the walking skeleton

Backlog item 0 is done and passed end-to-end against real Docker/Postgres
(`./scripts/verify-walking-skeleton.sh`). Along the way, several things in this document's
original draft turned out to be wrong or incomplete once actually built and run — recorded
here so they aren't silently rediscovered later:

- **Next.js under `bun run start` works** — the single biggest flagged risk. Confirmed: it
  compiles, builds all routes, and serves real requests. `output: "standalone"` does **not**
  work with `next start`, though (Next explicitly wants `node .next/standalone/server.js`
  for that mode, unverified under Bun) — dropped standalone for now; the image ships
  `node_modules` instead. Revisit in backlog item 9 if image size matters enough to justify
  verifying that path too.
- **A Dockerfile only sees what it `COPY`s.** `apps/web/tsconfig.json` extends the repo-root
  `tsconfig.base.json`; the Dockerfile didn't copy that file, so `next build`'s type-check
  step failed inside the container even though it passed on the host every time.
- **`localhost` inside a container means the container itself.** The `.env` used for
  host-side scripts correctly points at `localhost:5432` (the published port). The
  containerized `web`/`worker`/`migrate` services need the Postgres *service name* instead —
  now overridden explicitly in `docker-compose.yml`'s `environment:` block for those three
  services, which takes precedence over `env_file` for the same key.
- **pg-boss's own idempotent `CREATE SCHEMA IF NOT EXISTS` still needs database-level
  `CREATE`.** Postgres checks that privilege before checking whether the schema already
  exists, so even though `app_runtime` already owned the `pgboss` schema outright, pg-boss's
  own startup check failed with "permission denied for database" until `app_runtime` was
  also granted `CREATE ON DATABASE` — a narrow addition that still doesn't let it create
  anything inside `public`.
- **A root-level script needs its workspace dependency declared at the root, too.** Bun's
  workspace linking only makes `@galm/db` resolvable from `/scripts` once the root
  `package.json` itself lists it as a dependency — being a sibling workspace package isn't
  enough on its own.
- **Constructing a DB client at module load time breaks Next's build.** `next build`
  statically imports every route module to collect page data, which runs top-level code
  even for routes never invoked - including a DB client eagerly built at import time. Fixed
  by deferring the failure to first real query instead of client construction, so a build
  environment without a live `DATABASE_URL` (e.g. building the image before Postgres is
  reachable) doesn't crash the build itself.
- **Enforcing RLS on the `user` table would have broken login outright** — better-auth looks
  a user up by email before any tenant is known, which is how the tenant gets determined in
  the first place. Auth tables are deliberately not under RLS; see section 6 above.
- **`FORCE ROW LEVEL SECURITY` (an earlier draft of this document) would have blocked the
  migration-owner role's own admin/seed operations**, since that role owns the tables and
  FORCE applies RLS to the owner too. Removed; see section 2 above for the corrected
  reasoning.

## Learnings from building the domain model (backlog items 2-3)

- **A DB client (`createAppDb()`) must always be a module-scope singleton, never
  constructed inside a request handler.** Two route handlers (`/api/register`,
  `/api/reauth`) and one shared helper (`lib/reauth.ts`) originally called it per-request;
  each call opens its own connection pool that's never closed, and repeated real requests
  during testing exhausted Postgres's connection limit ("remaining connection slots are
  reserved for roles with the SUPERUSER attribute"). Fixed by hoisting every call to module
  scope, matching the pattern the tRPC routers already used correctly.
- **The audit_log/approval_events hash chain is per-tenant in practice, not global across
  the table** - corrected from an earlier overstated claim in this document. The trigger
  function has no `SECURITY DEFINER`, so its own lookup of the previous row runs under RLS
  like any other query, meaning it only ever sees - and chains to - rows in the same
  tenant. Confirmed by testing across two tenants: a first-ever row for tenant B had no
  `prev_hash` even though tenant A already had rows. This is the *correct* scope, not a gap:
  a genuinely cross-tenant chain would require bypassing RLS to compute, and would then be
  unverifiable by any single tenant anyway, since they can never read another tenant's rows
  to confirm the linkage. Each tenant's own history is independently tamper-evident, which
  is what actually matters for this product.
- **Drizzle needs an explicit (even if dummy) default on any column a DB trigger, not the
  app, populates**, or every insert call site is forced to supply a value the trigger will
  overwrite anyway. `audit_log.row_hash` and `approval_events.row_hash` are always
  overwritten by their `BEFORE INSERT` trigger regardless of what's supplied - marked
  `.default("")` so Drizzle's insert type treats them as optional without misrepresenting
  who actually owns the value. This was a latent bug in `audit_log` from backlog item 0 too;
  it only surfaced once a second call site (`packages/core`) was type-checked for real -
  `/scripts` had never had its own `tsconfig.json`, so `bun run` (which doesn't type-check)
  was silently masking it. Fixed by adding `scripts/tsconfig.json` and a root `typecheck`
  script that covers every workspace including `/scripts`.
- **Statuses are per-tenant rows keyed by a fixed `category`, not a hardcoded enum** - the
  customizability requested for this feature. Verified end-to-end: default sign-up seeds
  four statuses (Draft/In Review/Approved/Baselined), the workflow engine
  (`packages/core/src/requirement-status.ts`) only reasons about the four fixed categories,
  and disabling a category (not yet wired to a settings UI, but the data model supports it)
  would transparently skip it in `nextAllowedCategories` rather than dead-ending.
- **A migration that introduces a new per-tenant invariant needs a data backfill, not just
  a new code path.** Real incident: a tenant created in the browser before the domain-model
  migration shipped had zero `requirement_statuses` rows, since seeding only ever happened
  in `/api/register`'s code - "no enabled status configured for category 'draft'" on
  requirement creation. Not a code bug (every fresh registration seeds correctly, confirmed
  by `tests/e2e.test.ts`), but stale pre-migration data with no path to acquire the new
  invariant. Fixed the specific tenant, then generalized into
  `scripts/backfill-tenant-defaults.ts` (idempotent, safe to re-run) for the same class of
  drift in the future. This is also exactly why `tests/e2e.test.ts` exists now instead of
  re-typing `curl` commands by hand each time - it wouldn't have caught this specific
  incident (every test starts from a fresh registration), but it does mean every other
  regression in this flow gets caught automatically from here on.
- **A dependency declared at the root `package.json` couples every Dockerfile that does a
  partial/pruned workspace checkout**, even ones that never touch that dependency. Adding
  `@galm/core` to the root's own `dependencies` (for the backfill script) broke
  `packages/db/Dockerfile`'s build - it only copies `package.json` + `packages/db`'s, and
  Bun's install refuses a pruned checkout that's missing a workspace the root depends on,
  even though the migrate image never uses `@galm/core` at all. Fixed by giving `/scripts`
  its own `package.json` (a real workspace member, `@galm/scripts`) with exactly the
  dependencies it needs, and removing them from the root entirely - the root package itself
  should depend on nothing beyond dev tooling (`typescript`, `@types/bun`), so any
  Dockerfile copying only what it actually needs keeps working regardless of what other
  scripts or packages later grow to depend on.

## Requirement hierarchy & user-definable levels

Requirement type (User Need / System Requirement / Software Item Spec) followed statuses
into being a per-tenant customizable set: `requirement_levels` (name, sortOrder) replaces
what was a fixed CHECK-constrained `requirements.type` column. Unlike statuses, levels have
no fixed "category" the code needs special behavior for - `sortOrder` *is* the hierarchy
(a requirement's optional parent, chosen from a dropdown, must be at a strictly lower
sortOrder - see `createRequirement`'s validation), so level management is plain CRUD
(create/rename/reorder/delete) rather than the enable/disable model statuses use. Deleting
a level is refused while any requirement still uses it, or if it's the tenant's last one.

The product page shows one list per level (tabs), not one flat list, since the product
brief specifically named different people working at different levels.

**Migrating an existing CHECK-constrained column with live data, without a TTY:**
`drizzle-kit generate`'s interactive rename-detection prompt needs a real terminal and
can't run headless. Removing `type` and adding `levelId` in the same schema.ts edit
triggers it (add+drop in one table). Worked around by splitting into two generate calls -
first with `type` temporarily left alongside the new `levelId` column (purely additive, no
prompt), then a second with `type` finally removed (a pure drop is also unambiguous, no
prompt). The generated "add levelId" migration was hand-edited to be nullable rather than
NOT NULL (safe against existing rows); the generated "drop type" migration was replaced
with a no-op, since dropping it needs to happen *after* a data backfill that reads the
still-existing `type` column, which can only run from a `migrations-manual/*.sql` file -
and those always run after every drizzle-managed migration, never in between two of them.
Both stubbed-out `.sql` files are kept (not deleted) purely so the snapshots drizzle-kit
wrote alongside them stay accurate for future `generate` diffs - a migration file's
snapshot, not its literal SQL content, is what future generates diff against, so hand-editing
or neutering a generated file's SQL is safe as long as the snapshot reflects schema.ts.
This same technique is the answer for any future column removal against a table with real
data. The actual backfill (mapping every existing row's `type` string to the matching new
`requirement_levels` row per tenant) lives in `migrations-manual/004_requirement_levels.sql`
and was verified against the live dev database's real accumulated test data with zero data
loss before `type` was dropped.

**Built and rebuilt is not deployed**: `docker compose build web` produces a new image, but
the already-running container keeps serving the old one until it's explicitly recreated
(`docker compose up -d web`). Hit this directly while testing the levels feature - the new
`requirements.listLevels` procedure returned "No procedure found" against a freshly rebuilt
image because the container itself hadn't been swapped yet.

## Known risks (accepted, not re-litigated)

- **Bun in production**: self-hosting Next.js under `bun run start` (not Vercel) is a
  less-traveled path; compatibility is dependency-by-dependency, not blanket-guaranteed.
  **Verified working** for this walking skeleton's dependency set (see the learnings section
  above) - remains something to watch as more dependencies (real domain logic, PDF export,
  Jira/Spira clients) are added in later backlog items.
- **Shared-DB RLS**: strong defense-in-depth but easy to silently defeat (`app_runtime`
  accidentally granted table ownership or `BYPASSRLS`, an incident-response script that
  skips `SET LOCAL app.tenant_id`, or a future migration creating a tenant-scoped table
  without remembering to enable RLS on it). Needs a real automated cross-tenant-isolation
  test suite before considering multi-tenancy "done," not just trust in the policy DDL.
- **No proprietary-gating layer yet**: `PRODUCT.md`'s own monetization section already names
  specific future-paid features (SSO/SAML, Part-11 e-signature package, audit-log
  export/retention) that will, for now, ship fully open. That's a product-strategy question
  worth an explicit, even if loose, call before those specific features are built —
  self-hosters building real workflows around something like audit-log export before it's
  ever meant to be paid creates real backlash risk later. Flagged for a future decision, not
  blocking now.

## Test cases, steps, execution, and evidence (backlog item 4)

- **Rich text is sanitized HTML**, not markdown or plain text - "images, tables, other
  simple formatting" meant a real WYSIWYG editor (Tiptap, client-side) producing HTML,
  sanitized server-side (`packages/core/src/rich-text.ts`, using `sanitize-html`) before
  it ever reaches the database - never trust that the editor alone keeps content clean, a
  client can always call the API directly. Applies to step description/expectedResult/
  purpose and step-execution actualResult. HTML was chosen partly as the natural bridge to
  Spira's own HTML-based rich-text fields for the eventual Spira importer (backlog item 8)
  - that's the *reasoning* for the choice, not a claim of verified byte-level compatibility
  with Spira's actual export format, which hasn't been checked against real Spira data.
- **Test levels** (`test_levels`) are user-definable exactly like requirement levels,
  seeded with a single "Default" row rather than three - most teams start with one test
  organization scheme, not three. Unlike requirement levels, there's no hierarchy concept
  here (no parent/child between test cases), so it's plain CRUD with no sortOrder-based
  validation rule attached.
- **Test environments** (`test_environments`) are a second, independent user-definable
  list, recorded on every test execution - same pattern, same single-"Default" seed.
- **Requirement links are computed at read time, not synced at write time**: "if a step is
  linked, the test case automatically is" is `getEffectiveRequirementLinks` (in
  `packages/core/src/test-cases.ts`) computing the union of `test_case_requirement_links`
  (direct) and every linked step's `test_step_requirement_links` on every read - a step
  link is never copied into the test-case-level table. Simpler and can't drift out of sync
  the way a write-time copy could.
- **Evidence is per step execution, not per execution as a whole**: `attachments` is a
  generic file registry (nullable `testStepExecutionId`) backing both evidence and any
  image embedded in a rich-text field. Images embedded in stored HTML reference a stable
  `/api/attachments/[id]` URL, never a storage-signed URL directly - a signed URL would
  eventually expire; the route re-signs a fresh one from the storage driver on every
  request instead, session-authenticated (not token-authenticated) since the whole point is
  a URL that keeps working indefinitely for anyone who can already see the content.
- **A step execution snapshots its step's content at start time**
  (`descriptionSnapshot`/`expectedResultSnapshot`), since `test_steps` isn't versioned the
  way requirements are - without this, editing or removing a step after execution would
  silently rewrite history. Test cases themselves have no approval/versioning workflow at
  all (unlike requirements) - not requested for this feature, and a real scope decision:
  editing a test case's steps after creation isn't built yet, only create-with-steps and
  execute-against-them.
- **An execution's overall status is a computed rollup, not independently settable**: fail
  beats blocked beats pass, and completion is refused outright while any step is still
  `not_run` - a run isn't "done" with pending steps.

Two real bugs surfaced building this, on top of what's in the Learnings section below:
- **Ten files independently calling `createAppDb()` at module scope each opened their own
  connection pool** - individually correct (module scope, not per-request - a different
  mistake made and fixed earlier), but the *sum* of ten separate pools exhausted
  Postgres's connection ceiling with zero per-request leaking anywhere. A blind
  `.catch(() => null)` around the failing query then made this look like a plain 404
  ("attachment not found") rather than a connection error, and only direct-to-database
  debugging (bypassing the HTTP layer entirely) revealed the real cause. Fixed by
  consolidating to one shared pool (`apps/web/src/lib/db.ts`) imported everywhere, and by
  logging the error before returning 404 instead of swallowing it silently.
- **The manual-SQL migration runner re-executed every file on every migrate run**, assuming
  every file would stay safely re-runnable forever. That broke the moment migration 004
  dropped `requirements.type`, which migration 002 (already fully applied, long before) still
  unconditionally references in a CHECK constraint - a live re-run failed on "column type
  does not exist" against real accumulated dev data, not a hypothetical. Fixed with
  standard run-once tracking (`manual_migrations_applied`, checked before each file runs) -
  what every other migration tool already does, and what this project's manual-SQL
  migrations should have had from the start.

## Requirement background field, and the Spira importer (backlog items 8-9)

- **`background`** (`requirement_versions.background`) is an optional field, sanitized
  rich-text HTML like `test_steps`/`test_step_executions` fields - added specifically
  ahead of the Spira importer, since Spira's own requirement fields are typically rich
  HTML and this is exactly the kind of free-form context (rationale, strategic fit) a
  Spira "Background"-style field tends to hold. Unlike `background`, `description` predates
  rich-text support and is still plain text - the importer strips HTML entirely (not just
  sanitizes) when mapping into it, rather than leaving literal tags visible; see below.
- **The importer is REST-only and one-time** (not a persistent sync), now covering both
  requirements and test cases - matching the original design in this document apart from
  test-case import, which was originally deferred and has since been built (see below). A
  SOAP fallback for older self-hosted Spira instances is still a real gap, not built.
- **"Import all" pages through the whole project automatically**, for both artifact types -
  `runSpiraImport`/`runSpiraTestCaseImport` fetch 100 rows at a time (`SPIRA_IMPORT_PAGE_SIZE`
  in `packages/integrations/spira/src/pagination.ts`, shared by both) until a page comes
  back short, rather than requiring the operator to manually re-run with a higher starting
  row for every page. `startRow` still exists as an input, repurposed as a resume point for
  a run interrupted partway (e.g. a transient network error) rather than a page-size limit.
  Capped at 20,000 rows as a runaway-loop safety net, not a normal-path limit - a genuinely
  huge project would eventually want this moved to a pg-boss job with progress polling
  instead of one long synchronous HTTP request.
- **Test cases import as case + steps together**, one Spira request per test case for its
  steps (`GET /projects/{id}/test-cases/{test_case_id}/test-steps` - confirmed against a
  real Spira instance; no bulk "all steps for a project" endpoint exists, so this is
  inherently N+1 in Spira requests, not in our own database - fine at these dataset sizes).
  Unlike requirements, our test case model has no case-level description field (only steps
  carry rich text), so **only Title is a chosen mapping** - Spira's own test case
  Description is never imported, an explicit scope cut. Every step's Description and
  Expected Result are always read directly (they're what's fundamentally being imported,
  not a choice); **Purpose** is the one optional per-step mapping, sourced from any
  Test Step field including a custom one. Test Type (verification/validation) and Test
  Level are fixed choices applied to the whole batch, not sourced from Spira, since its own
  test case type taxonomy doesn't map onto our two-valued split. A Spira test case with zero
  steps is skipped with a clear per-row message, since our model requires at least one step
  - consistent with "per-row failures don't abort the batch" below.
- **Custom-field discovery was generalized to any artifact type name**: the same
  `/project-templates/{id}/custom-properties/{artifact_type_name}` call now backs
  `listRequirementFields`, `listTestCaseFields`, and `listTestStepFields` via one shared
  private `discoverFields(artifactTypeName, standardFields)` method, rather than
  duplicating the lookup-then-fetch logic per artifact type.
- **Re-importing is idempotent by source id, for both requirements and test cases** - a
  generic `external_links` table (`packages/db/src/schema.ts`: tenant, entity type, entity
  id, source, external id) records which local row came from which Spira row, deliberately
  not Spira-specific: it's the same shape a future Jira integration (backlog item 8, which
  also wants bidirectional sync) would need, so it's built as one reusable table rather
  than growing a `spira_id` column per importable entity. Two unique constraints do the
  real work: `(tenant, entity type, entity id, source)` (an entity can't claim two external
  ids from the same source) and `(tenant, entity type, source, external id)` (this is what
  actually prevents re-import from creating a duplicate - one local entity per source row).
  `createOrUpdateRequirementFromImport`/`createOrUpdateTestCaseFromImport`
  (`packages/core`) look up the external id before writing: not found → create (and record
  the link); found → reconcile in place. Both compare incoming content to what's already
  stored and report `"unchanged"` without writing anything when nothing differs, so
  re-running an import isn't noisy when the source hasn't changed.
  - **Requirements**: an update reuses `editDraftVersion` - the exact same rule manual edits
    already follow. A requirement that has moved past Draft is reported `"skipped"` with
    the reason, not silently rewritten - re-import respects the same approval workflow a
    human editing it by hand would. Safety classification is only set on first import;
    there's no metadata-only update path for it outside creation yet (a real gap, not a
    deliberate cut here).
  - **Test cases**: reconciliation is per-step, matched by each step's own recorded
    external id (not by position) - title and any changed step's content are updated in
    place, a step present in the source but not yet local is created, and a step that
    disappeared from the source is **left alone, never deleted**. Two independent reasons
    for that: `test_step_executions.test_step_id` has no `ON DELETE CASCADE` (a historical
    execution must stay resolvable even if the step is later removed), and more
    fundamentally, silently deleting a step nobody asked to remove isn't safe to do
    automatically regardless of the FK. A human has to remove a step that no longer exists
    at the source - this is the one real gap in "sync," not a hidden one.
  - **What this doesn't do yet**: no sync-*back* (writing local changes to Spira) - storing
    the mapping is what makes that feasible later without a data migration, but the write
    path itself isn't built. `lastSyncedAt` exists on `external_links` for exactly that
    future feature and is never set today.
  - **Verified end-to-end against a mock server with mutated content between two import
    runs**: row counts in the database were confirmed *not* to double on the second run;
    a requirement with an actually-changed description came back `"updated"` (with a new
    version) while an untouched one came back `"unchanged"`; a test case with one edited
    step and one newly-added step came back `"updated"` with an accurate per-step count
    (`"1 step(s) created, 1 updated, 1 unchanged"`) while an untouched test case came back
    `"unchanged"`; and a requirement moved to In Review before its source content changed
    came back `"skipped"` with the same message `editDraftVersion` gives a manual edit
    attempt, while a still-Draft requirement in the same run correctly updated.
- **The field mapping is deliberately not persisted** - the Spira *connection*
  (`spira_connections`, one row per tenant: base URL, API version, username, API key,
  project id) is saved so it doesn't need re-entering, but which Spira field feeds which
  of our fields is chosen fresh each time in the import wizard's own page state. Custom
  fields vary per Spira installation/project, so hardcoding a mapping wouldn't travel
  between customers anyway - configuring it per-run is the more honest model, not a
  corner cut.
- **The API key is stored in plain text** in the tenant-isolated, RLS-protected
  `spira_connections` table - the same trust boundary as the rest of this database, with
  no separate encryption-at-rest layer (none exists in this project yet). Worth knowing
  before pointing this at a production Spira instance.
- **Custom properties are defined per project *template* in Spira, not per project** -
  confirmed against Inflectra's own REST API documentation:
  `GET /project-templates/{project_template_id}/custom-properties/{artifact_type_name}`.
  `listRequirementFields` first looks up the project's `ProjectTemplateId`, then queries
  that endpoint for the Requirement artifact type. Falls back to standard fields alone if
  either call fails - Spira's exact REST API shape (base path, some endpoint names) still
  varies across versions (v3_0-v7_0+) and between Cloud vs. self-hosted installs, so the
  base URL stays entirely user-supplied - but the failure is now returned as a visible
  `customFieldsWarning`, not silently swallowed.
  **Real incident this replaced**: the original implementation guessed
  `/projects/{project_id}/requirements/properties` (wrong path) and swallowed the failure
  completely, so a real user testing against their real Spira instance saw their custom
  "Background" field simply missing from the list with no error at all - the actual bug
  was invisible until the failure was made visible and the real endpoint was looked up
  properly instead of guessed again.
- **Per-row failures don't abort the batch**: `runSpiraImport` catches and records each
  row's own error (e.g. one malformed Spira record) and continues, returning a full
  per-row result list rather than failing the whole run on one bad row.
- **Verified against a real (mock) Spira server, and later against the user's actual
  production Spira instance.** Early development used a small mock REST server standing in
  for Spira, reachable from the web container via the Docker bridge gateway - connection
  save/test, field discovery including custom properties, preview, and a real committed
  import, for both requirements and test cases, all confirmed end to end this way,
  including a 150-row mock project spanning two pages to confirm "import all" pages
  correctly. A found-and-fixed rough edge from that testing: naively stripping HTML tags
  for the `description` mapping collapsed adjacent block elements together with no
  separator (`"detail a" + "detail b"` → `"detail adetail b"`) - fixed by inserting a space
  at block-level closing tags before stripping.

  The test-case importer was additionally verified directly against the user's real,
  already-populated Spira project (given transiently for exactly this purpose, not written
  to any version-controlled file - stored only in the running app's own `spira_connections`
  table, the same trust boundary as any other saved connection): connected, discovered its
  real custom fields (a "Purpose" text field on Test Step - confirming the generalized
  custom-field discovery genuinely works, not just against a mock shaped to match the
  guess), previewed real test cases with real HTML-formatted steps, and ran a full import -
  all 71 of the project's test cases (and their steps) created with 0 errors, matching the
  real project's own test case count exactly. This is a stronger verification bar than the
  mock-only pass the original requirements importer shipped with, and worth repeating for
  the requirements side too when there's a reason to touch that code again.

## Navigation & information architecture (backlog item 9.5)

- **Designed before it was built**: a Mermaid diagram of the actual current link graph
  (built from what was really in the code, not assumed), a redesigned diagram, then a
  clickable HTML mockup - all reviewed with the user before any component code changed.
  Two rounds of real feedback reshaped the design before implementation: first, that people
  work one product/level at a time and rarely switch products, which is why the product
  switcher is a small rare-use control rather than a peer nav item; second, that
  Requirements and Test Cases are separate contexts (each with its own level set) and that
  import/export belongs inside Settings, not next to it, since it's not a frequent action.
- **The context strip is rendered per-page, not via a shared layout slot.** A Next.js
  `layout.tsx` can't easily receive page-specific data (which product, which level) without
  threading it through a client-side React Context for content that varies this much page
  to page - not worth it for one row of UI. `apps/web/src/components/context-strip.tsx`
  exports `TopBar` (the shell + the avatar/settings corner every page gets) and
  `ProductContextStrip` (the product/artifact/level content, for the four pages actually
  scoped to one product); each page imports and renders whichever applies, as its own first
  element.
- **Level/artifact selection lives in the URL**, not component state: the product page reads
  `?artifact=requirements|testCases&level=<id>` via `useSearchParams`, falling back to the
  first level of whichever artifact is active if the param is missing or stale (e.g. left
  over from switching artifact). This makes the URL the single source of truth the context
  strip's links and the page's own data-fetching both read from, rather than two places
  (a tab bar and a section component) agreeing by convention - which is also exactly what
  `RequirementsSection`/`TestCasesSection` used to do with their own local `useState`,
  removed as part of this change.
- **A new `(app)` route group** (`apps/web/src/app/(app)/layout.tsx`) covers every page
  except `/log-in` and `/register`, and checks the session once, redirecting if absent.
  Previously only the home page did this - every other page relied on a `protectedProcedure`
  tRPC call simply failing with `UNAUTHORIZED` if the session was missing, which produced an
  error state rather than a clean redirect. Moving pages into a route group in Next.js App
  Router is a pure file-move (it doesn't change the URL), so `/products/[id]` etc. kept
  their exact paths.
- **Spira import moved from `/import/spira` to `/settings/import`**, linked from a section
  inside `/settings` rather than sitting as a peer top-level destination - no schema or
  server-side change, since `packages/integrations/spira` and the `spiraImport` tRPC router
  are addressed by procedure name, not file path.
- **No schema or backend changes at all** - this entire pass is `apps/web` only. Verified
  against live containers: a full rebuild, all 29 e2e tests still passing (they exercise the
  tRPC layer, which this didn't touch), and every affected route hit directly with real ids
  (register → create a product/requirement/test case/execution → load each page), checking
  for a clean 200 and the context strip's real markup in the server-rendered HTML, plus
  confirming `/import/spira` now 404s and `/settings/import` serves the moved wizard.

## UI component library and design tokens (backlog item 9.6)

Adopted shadcn/ui (the library the original tech-stack plan named but never actually
installed - every page since had hand-written its own Tailwind instead). Confirmed
compatible with the real stack via shadcn's own current docs before starting, not assumed:
Tailwind v4 (CSS-native `@theme` tokens), Next.js 15, React 19.

- **`bunx shadcn@latest init -d -y` ran non-interactively**, same TTY concern as
  drizzle-kit's interactive rename prompt earlier - the CLI's `-d`/`-y` flags handled it
  fine, no fallback needed this time. Current shadcn (`"style": "base-nova"` in
  `components.json`) is built on **Base UI** (`@base-ui/react`), not Radix - a newer
  generation of the tool than commonly documented online. Components land in
  `apps/web/src/components/ui/`: `button`, `input`, `textarea`, `label`, `select`, `card`,
  `badge`, `dialog`, `dropdown-menu`.
- **Base UI components compose via a `render` prop, not Radix's `asChild`** - e.g.
  `<DropdownMenuItem render={<Link href="..." />}>`. For a non-interactive element that
  just needs to *look* like a `Button` (an `<a>`, a file-upload `<label>`), the actual
  fix is applying the exported `buttonVariants({...})` classes directly to that element,
  not composing through `Button` at all. `Card` has no polymorphism at all (it's a plain
  styled `<div>`) - wrap it around the real element (`<li><Card>...</Card></li>`) rather
  than trying to make it render as one.
- **One deliberate accent, not shadcn's default grayscale `--primary`**: a deep teal
  (`oklch(0.45 0.08 192)`), continuing the same reasoning as the Navigation Blueprint
  review artifact - clinical precision + traceability, not a generic Linear-indigo or
  Vercel-black. Spent in exactly two places (buttons/links via `--primary`, focus rings via
  `--ring`) - everywhere else stayed the existing neutral grayscale, which already read as
  a clean developer-tool look matching PRODUCT.md's own Linear/Qase benchmark.
- **`next/font/google` self-hosts IBM Plex Sans + IBM Plex Mono at build time** - not
  Geist (shadcn's own init default) or Inter (the generic "safe" choice), and not a
  runtime CDN `<link>` (fine for a one-off Artifact mockup, wrong for a product that ships
  as a self-host Docker image - a self-hosted install shouldn't phone home to Google Fonts
  on every page load). Mono is reserved for identifiers (requirement/test-case ids, version
  numbers), not general UI text.
- **A real bug the init exposed, not introduced**: `globals.css` had an *unlayered*
  `body { @apply bg-neutral-50 text-neutral-900 antialiased; }` rule sitting above
  shadcn's generated `@layer base { body { @apply bg-background text-foreground; } }`.
  Unlayered CSS always wins over layered CSS regardless of source order, so the token-based
  rule was silently inert from the moment it was added - fixed by trimming the original
  rule down to just `antialiased`, the one thing it needed to still do.
- **Three independent hand-coded status-color maps collapsed into one**: `status-pill.tsx`
  used to have its own map for requirement statuses, and the test-case/execution detail
  pages each had their own near-identical map for step/execution results. Now `StatusPill`
  and a new `ResultBadge` are both thin wrappers over `Badge`, which gained `success`/
  `warning`/`info` variants (soft-pill light-bg/saturated-text, matching this app's existing
  look - not shadcn's default solid-bg/white-text badge style, a deliberate choice to match
  what was already established rather than switch styles).
- **Multi-select requirement pickers stayed native `<select multiple>` for this pass** -
  Base UI's `Select` (like most headless select primitives) has no drop-in equivalent for
  native multi-select listbox semantics. Restyled to match the new tokens, not left on the
  old raw Tailwind classes. Later replaced by a searchable tag/chip combobox once Base UI's
  own `Combobox` (with `multiple` + `Chips`) shipped - see "Requirement linking UI, and
  navigation polish" below.
- **The Requirements/Test Cases toggle in the context strip deliberately isn't Radix/Base UI
  `Tabs`** - it's real navigation to a different URL (`?artifact=`), not client-side panel
  switching, so `Tabs` would be the wrong primitive despite looking similar.
  `RichTextEditor`/`RichTextView` (Tiptap) were out of scope too - a rich-text engine, not a
  form primitive.
- **Dark mode was deliberately not touched** - `globals.css` still hardcodes
  `color-scheme: light`; shadcn's init did generate a `.dark` class with its own token
  values, left in place unused (a reasonable starting point for that future pass, not worth
  customizing now since nothing applies it).
- **Verified against live containers**: full rebuild, `next build` succeeded (catches any
  Tailwind v4/Base UI/Next 15 integration issue a plain typecheck wouldn't), all 29 e2e
  tests still passing (pure UI-layer change, no tRPC/schema touched), and all eleven
  user-facing routes (including `/log-in`, `/register`, now migrated too for consistency)
  hit directly with real ids from a fresh registration - clean 200s, no error markers, the
  context strip's real markup present in the server-rendered HTML. No headless browser is
  available in this environment, so real interaction quality (the new `Dialog`'s focus
  trap, `DropdownMenu`/`Select` keyboard nav) couldn't be clicked through here - worth
  eyeballing yourself, the same caveat given after the navigation pass's dropdowns.

## Visual style: Slate & Indigo, flat buttons, dividers not cards (backlog item 9.7)

The shadcn adoption above gave galm real components, but with shadcn's own defaults the
result still read as generic - a diagnosis reached and design directions explored through a
second review artifact (Galm Visual Style Options: a live before/after of one real screen,
live buttons, and three color-palette candidates), the same review-before-code pattern as
the navigation pass. Three rounds of real feedback shaped what shipped:

- **The teal accent (picked for the navigation-pass artifact) was replaced with "Slate &
  Indigo"** after a side-by-side comparison of three candidates - a deep desaturated
  navy-indigo `oklch(0.36 0.045 265)` on a faintly cool-slate page background
  (`oklch(0.965 0.006 275)`, not stark white), `--card` staying crisp white so real panels
  visibly sit above the page. The specific lesson from comparing candidates: teal-on-white
  was generic as much because of the *stark white* as the hue choice - every candidate that
  read as "considered" moved the page background off pure white, regardless of which accent
  it paired with.
- **A 3D button treatment (gradient + inset highlight + press-down transform) was built,
  shown, and explicitly rejected** - "I don't care much for the 3d button." Reverted to a
  flat fill; the real fix for "generic" turned out to be the hover behavior, not depth:
  - The primary button's hover is a literal darken (`--primary-hover`, a `color-mix` with
    black, exposed as the `bg-primary-hover` Tailwind utility via the `@theme inline`
    mapping) - an opacity-fade hover (`hover:bg-primary/80`, shadcn's default) lightens a
    button against this pale a background instead of deepening it, which reads as
    "washing out," not "responding to your click."
  - Outline and ghost buttons hover toward `--primary` (`hover:bg-primary/10`,
    `hover:text-primary`) instead of plain neutral `--muted` - every interactive control
    now reads as one family instead of the accent living only on the primary button.
  - Shadcn's own `--accent`/`--accent-foreground` tokens (the "interactive highlight" used
    by `DropdownMenuItem`/`SelectItem` on hover/focus) were retinted toward primary too -
    one token change, zero edits to `dropdown-menu.tsx`/`select.tsx`, and menus/selects
    automatically match the button family.
- **`--radius` dropped from shadcn's default `0.625rem` to `0.375rem`** - since every
  `rounded-*` utility across every component reads from the `--radius-sm/md/lg/xl` scale in
  the `@theme inline` block (all derived from the one `--radius` variable), this single
  edit retightened buttons, inputs, selects, and cards together without touching per-
  component radius classes.
- **`Card` lost its `ring-1 ring-foreground/10` in favor of a plain `border border-border`**
  - a real panel (a form, the Spira connection block) earns a boundary; it doesn't need a
    shadow/ring doing extra work to look "elevated."
- **Simple navigational list rows moved off `Card` entirely, onto one shared divided-list
  pattern** (`<ul className="divide-y divide-border overflow-hidden rounded-md border">`,
  each row `flex items-center justify-between gap-3 px-* py-* hover:bg-muted/50"`) - the
  literal "everything is a card" tell: wrapping every single row in its own bordered box
  was the same treatment as the whole creation panel, when a row and a panel aren't the
  same kind of object. Applied to: the product list, the requirement/test-case lists inside
  a product, a requirement's version history, a test case's execution history, the settings
  status list, and `OrderedListEditor` (shared by hierarchy levels/test levels/
  environments). **Left as real `Card`s** because they're substantive content blocks, not
  simple nav rows: the create/edit forms, a test case's step content, a step execution's
  record-a-result card, and the Spira import preview rows.
- **The accent now shows up in the data, not just the button**: version numbers
  (`v{n}`, `font-mono text-primary`) and "traces to"/"traced to by" links across the
  requirement and test-case detail pages are tinted with `--primary` - the two places that
  are actually about traceability, the product's whole point, rather than the accent living
  only on "Create requirement."
- **Verified against live containers**: rebuilt, `next build` succeeded, all 29 e2e tests
  still passing (pure token/component-file change, no schema/tRPC touched), all ten
  user-facing routes hit with real ids from a fresh registration returned clean 200s, and
  the compiled CSS actually served by the running container was fetched and checked
  directly - confirmed `--radius:.375rem` and `--primary:oklch(36% .045 265)` are really in
  the shipped stylesheet, not just the source file.

**Two real bugs found by actually using the shipped app, not by review:**

- **The navigation pass's "the context strip replaces the back-link" design didn't hold up
  in practice.** Clicking an already-active level pill in a dropdown to navigate back to
  the list isn't discoverable as a "go back" action - it reads as "this shows where I am,"
  not "click here to leave." Fixed by restoring an explicit breadcrumb link
  (`← Back to {level name}`) on `/requirements/[id]` and `/test-cases/[id]`, pointing at
  `/products/{id}?artifact=...&level=...`, plus a plain `← All products` on
  `/products/[id]` - the context strip stays for *switching* context, the breadcrumb is
  back for *returning*. `/test-cases/[id]` needed an extra `testCases.listLevels` query
  added just to resolve the level's name (`testCases.get` only returns `levelId`, unlike
  `requirements.get` which already joins the level name in).
- **The "Run test" button next to the Environment dropdown was visibly misaligned** - both
  controls are `h-8`, `items-end` on the row should have aligned their bottoms in theory,
  but relying on flex cross-axis alignment across two structurally-different columns (one
  stacked label+control, one a bare button) left it visibly off. Fixed by giving the
  button its own matching column - `<Label className="invisible">Run</Label>` above it -
  so both columns are the same shape (label row + control row) and their bottoms align by
  construction, not by hoping the flex math works out. Checked the rest of the app for the
  same stacked-label-next-to-button shape (only `grep -rn "items-end"`, one match) rather
  than assuming this was the only instance.

## Tenant-defined custom fields (backlog item 9.19)

Teams need fields beyond the fixed built-in set, and what they need varies too much
between teams to be a fixed list - so it's user-defined, per tenant, per entity type
(requirement or test case).

- **Storage: three tables**, the same "tenant-owned ordered list" shape `levels`/
  `requirement_statuses`/`test_environments` already use - `custom_field_definitions`
  (name, `field_type` - `short_text`/`long_text`/`list`/`date`/`integer`/`boolean`,
  CHECK-constrained - `is_required`, `sort_order`), `custom_field_list_options` (a
  `field_type='list'` field's allowed values), and `custom_field_values` (one row per
  (field, entity) that actually has a value set - PK `(field_id, entity_id)`, so an unset
  optional field is simply an absent row, not a null one). `value` is always `text`
  regardless of declared type - an integer as digits, a boolean as "true"/"false", a date
  as ISO "YYYY-MM-DD", a **list selection as the chosen option's uuid, not its text** -
  storing the id rather than the text is what makes renaming an option free (nothing
  references its text) while deleting an option still in use has to be blocked (see
  packages/core/src/custom-fields.ts's `deleteCustomFieldListOption`). `entity_id` is
  polymorphic (a requirements.id or test_cases.id depending on the field's entityType),
  same reasoning as `external_links.entityId`/`audit_log.entityId` elsewhere in this
  schema - can't be a real FK.
- **Deliberately not versioned** - closer in spirit to `requirements.
  safetyClassification` (real content, but metadata a team corrects directly) than to
  title/description/background (which get a new version and an approval-workflow status
  on every change). Keeps the feature symmetric between requirements and test cases, since
  test cases have no versioning concept to hang it on at all. A separate
  `updateCustomFieldValues` mutation on both `requirements`/`testCases` routers, not
  folded into `editDraft`/`update` - editing a custom field never creates a new version or
  touches approval status.
- **`setCustomFieldValues` (packages/core/src/custom-fields.ts) reconciles the *complete*
  set of a tenant's defined fields against whatever the caller sends, every call** - a
  field left out of the payload is treated as cleared, not left alone, and every defined
  field's required-ness is enforced regardless of whether the caller even mentioned it.
  This matches how both the create forms and each detail page's "Custom fields" edit
  section are built: always collect and submit the full set, never a partial patch. Per-
  type validation (`validateCustomFieldValue`) normalizes a raw input into that exact
  stored-text encoding, or throws a `DomainError` naming the field.
- **UI**: a new `/settings/custom-fields` screen (two sections, requirement/test case,
  same page-per-concern split as `/settings/import`'s hub+screens) manages definitions and
  list options - reorder, rename (free), required toggle, delete (a field's delete
  confirm explicitly warns it's permanent data loss, since nothing blocks it the way an
  in-use level/status does). A shared `apps/web/src/components/custom-fields.tsx` renders
  the per-type form input (`CustomFieldInputs`), formats a value for read-only display
  (`formatCustomFieldValue`), and provides a small popover checklist
  (`CustomFieldColumnPicker`) for choosing which custom-field columns to show on the
  requirement list, test case list, and traceability matrix (both requirement- and test-
  case-side columns there) - selected columns live in the URL (`?columns=...`), same
  shareable-link convention `use-url-state.ts` already established for sort/filter
  elsewhere. **Deliberately duplicates a small type list from `@galm/core`
  (`CUSTOM_FIELD_TYPE_OPTIONS`)** rather than importing `CUSTOM_FIELD_TYPES` - `@galm/core`'s
  barrel unconditionally pulls in `@galm/db`'s Bun-native Postgres client, which breaks the
  client bundle if imported from a client component (the exact regression `format-item-id.ts`
  hit earlier this session, and the reason this file has to be self-contained too).
- **Spira import**: `RequirementFieldMapping`/`TestCaseFieldMapping` gained a
  `customFields?: Record<string, string>` (our field id -> the Spira field key to read for
  it) - dynamic, since custom fields are tenant-defined, unlike every other fixed mapping
  target. `packages/integrations/spira/src/custom-fields.ts`'s
  `loadCustomFieldMappingResolution` loads the tenant's field definitions and (for list
  fields) their options *once per import run*, then `resolveCustomFieldValues` is a pure
  per-row function: reads the mapped Spira field, and for a list field, matches its text
  against an option's text (trimmed, case-insensitive) to find that option's id - a
  stale/deleted mapped field id, or Spira text matching no defined option, resolves to
  "unset" rather than failing the row (required-ness is still enforced at the actual
  write, same as every other required field). Preview intentionally never resolves custom
  fields (stays a pure, DB-free Spira read) - only the real import run does.
- **Verified**: 5 new e2e tests (definition CRUD and its per-entity-type name-uniqueness;
  list-option rename-is-safe vs. delete-while-in-use-is-blocked; required-field
  enforcement on create *and* update, plus type validation; the same for test cases;
  cascade deletion of a whole field). Two new `scripts/verify-*.ts` (this session's
  pattern for internal-only mechanisms the black-box e2e suite can't reach, run for real
  against the live dev database): the core value-validation/reconciliation logic directly,
  and the Spira-import resolver specifically (case-insensitive option matching, a stale
  mapped field silently skipped, the full parse-resolve-create-read chain end to end).
  `bun run typecheck` clean across all 9 packages, full Docker rebuild clean (including
  the new route and the two import screens' new mapping fields), all 40 e2e tests pass.

### Follow-up bug: re-import action reporting didn't know about custom fields
  (backlog item 9.21)

A real user-reported bug, caught immediately after shipping: mapping a custom field for
the first time and re-running an import against rows already imported before reported
"0 updated," even though `setCustomFieldValues` had in fact written the value correctly -
`createOrUpdateRequirementFromImport`/`createOrUpdateTestCaseFromImport` already called it
unconditionally on every re-import (custom fields aren't versioned or status-gated, so
there was no reason not to), but the result was discarded, and the "unchanged" vs
"updated" action was decided purely by comparing title/description/background. **Fixed at
the source, not by special-casing the caller**: `setCustomFieldValues` now compares each
field's new value against what was already stored before writing, returning whether
anything actually changed (and, as a side effect, no longer issuing a write for a field
whose value didn't change) - both import functions fold that into their action decision.
"Nothing changed" now genuinely means title, description, background, *and* every mapped
custom field, not just the first three. Verified with 4 new checks in
`scripts/verify-custom-field-import-resolution.ts` (a true no-op still reports
"unchanged"; a custom-field-only change reports "updated"; the written value matches what
was reported) - `createOrUpdateRequirementFromImport` is only reachable through the Spira
import path, so this can't go through the e2e suite.

### Follow-up bug: `readSpiraField` only ever read a custom property's `StringValue`
  (backlog item 9.22)

The user re-tested 9.21's fix against a real, non-Text Spira custom field and still saw
"nothing updated" - the deeper root cause, not just a reporting bug. Spira's REST API puts
a custom property's actual value under whichever *type-specific* key matches that
property's own type in Spira - `StringValue` for Text, but `IntegerValue` for Number,
`BooleanValue` for Yes/No, `DateTimeValue` for Date, `DecimalValue` for Decimal, never more
than one populated at once. `readSpiraField` (packages/integrations/spira/src/client.ts)
only ever checked `StringValue`, so any mapped field that wasn't itself Text silently read
`null` forever - the value was never resolved at all, so 9.21's "did it actually change"
comparison had nothing to compare against. Fixed by checking all five value keys, in order,
with `!= null` rather than truthiness (a real value can be `false` or `0`, which a
truthiness check would wrongly treat as absent), and widening the `SpiraArtifact` type to
declare all five instead of just `StringValue`. Spira's `DateTimeValue` also comes back as
a full ISO datetime rather than a bare date, so the `date` custom field type's own
validation (packages/core/src/custom-fields.ts) was loosened to accept a leading
`YYYY-MM-DD` prefix and store just that.

One gap left deliberately unsolved: a Spira "List" custom property's value comes back as
only the selected item's numeric id (`IntegerListValue`), not resolvable to display text
without a separate Spira API call this client doesn't make - mapping a List-type Spira
custom field isn't usefully supported yet.

Verified with 9 new checks in `scripts/verify-custom-field-import-resolution.ts`, run for
real against the live dev database: `readSpiraField` directly for each of
`IntegerValue`/`BooleanValue` (including the falsy value `false` itself)/`DateTimeValue`/
`DecimalValue`, a negative case confirming it still returns `null` when nothing is set, and
a full integer/boolean/date field end-to-end through resolution, create, validation, and
read-back. User confirmed against their real data afterward: "Works!"

### Follow-up: Spira's standard Test Case "Type"/"Status" fields weren't mappable
  (backlog item 9.23)

The user then reported what looked like a third custom-field bug - "I don't see Spira
custom fields in test cases import... I see them on step level" - but this turned out not
to be a bug. Calling the same field-discovery method the import screen uses
(`SpiraClient.listTestCaseFields()`/`listTestStepFields()`) directly against the user's
real, already-saved Spira connection showed it working correctly: their project has zero
custom properties actually configured on the Test Case artifact type in Spira (only
Requirement and Test Step do), confirmed two ways - the discovery call itself returned
cleanly with no `customFieldsWarning`, and a direct raw request to Spira's
`custom-properties/TestCase` endpoint returned `200` with an empty array, while
deliberately-wrong artifact-type-name candidates (`Test Case`, `TestCases`) were correctly
`406`-rejected - proving `TestCase` is a real, recognized Spira artifact type that this
project simply has nothing defined under. Spira's own UI shows a test case's steps inline
right below the case, which is the likely reason a Test Step-level field (their "Purpose"
field from backlog item 9) reads as case-level.

That exchange did surface a real, separate gap: once the user meant Spira's *standard*
(non-custom) "Type" field, `STANDARD_TEST_CASE_FIELDS`
(packages/integrations/spira/src/client.ts) had no way to offer it - it only listed `Name`
and Spira's own `TestCaseId`. `STANDARD_REQUIREMENT_FIELDS` already includes Spira's
standard `RequirementTypeName`/`ImportanceName`/`StatusName` for exactly this reason: our
fixed verification/validation `testType` split doesn't line up with Spira's own type
taxonomy, so these are never written automatically (see `MappedTestCase.spiraTestCaseType`,
which the test-case importer already read and showed in preview, but never wrote), but a
team can still map one onto a custom field of their own via the generic custom-field
mapping. The test-case equivalents, `TestCaseTypeName` and `TestCaseStatusName`, were
simply absent from the list. Added both.

Verified directly against the user's real Spira project both before and after the change
(confirming `TestCaseTypeName`/`TestCaseStatusName` now appear where they didn't before),
plus `bun run typecheck`, a full Docker rebuild, and all 40 e2e tests.

### Follow-up bug: a list custom field with no matching option silently stayed "unchanged"
  (backlog item 9.24)

Right after 9.23 shipped, the user mapped Spira's newly-exposed Test Case Type field onto
one of their own list custom fields and re-ran the import - every row came back
"unchanged," a fourth instance of the same shape of surprise as 9.21/9.22. This time
nothing was actually broken: checked directly against the user's real tenant, their list
field simply had zero options defined yet, so `resolveCustomFieldValues`
(packages/integrations/spira/src/custom-fields.ts) correctly had nothing to match Spira's
value against and resolved it to `null`, and `setCustomFieldValues` correctly saw no
change (`null` before, `null` after). Every individual piece was working as designed - the
gap was that nothing said *why*.

Fixed by having `resolveCustomFieldValues` return a second, parallel list of unmatched
list values (`{ fieldName, rawValue }`, for any mapped list field whose Spira value was
non-empty but matched none of that field's own options), and a new
`formatUnmatchedListNote` helper turning that into one line, e.g. `"Environment": Spira
value "Hardware" doesn't match any option - left blank`. Both `runSpiraImport` and
`runSpiraTestCaseImport` fold this into the same per-row `note` the results table already
renders, alongside the existing legacy-id mismatch note (requirements) and steps-changed
note (test cases) - `formatUnmatchedListNote`'s output is simply joined in rather than
replacing whatever note was already there. Deliberately not a validation error and doesn't
fail the row: a list field with no match resolving to "unset" is legitimate (e.g. Spira
has a value the field's options genuinely don't cover yet), just no longer silent about
it.

Verified with 4 new checks in `scripts/verify-custom-field-import-resolution.ts`:
`resolveCustomFieldValues` reports the correct field name and raw value for an unmatched
list value; a value that *does* match produces no note; `formatUnmatchedListNote`'s exact
rendered text. `bun run typecheck` clean, full Docker rebuild clean, all 40 e2e tests still
pass.

### Follow-up: auto-create missing list options instead of just warning about them
  (backlog item 9.25)

The direct next question, right after 9.24 shipped: "can't you automatically add the
missing values when importing?" A fair ask - 9.24's note said *why* nothing updated, but a
team migrating an existing Spira taxonomy (their real Test Case Type values: Hardware,
Virtual, Hardware Network, Virtual Automated) still had to hand-type every one into
Settings before a re-import could use it, which mostly defeats the point of importing in
the first place.

Two new pieces. `getOrCreateCustomFieldListOption`
(packages/core/src/custom-fields.ts) is an idempotent, case-insensitive get-or-create,
kept deliberately separate from `createCustomFieldListOption` - the settings UI still uses
that one and still rejects a human-typed duplicate outright, since a person adding an
option that already exists is a real mistake worth catching, but an importer hitting the
same source value on two different rows (or a value someone already added by hand) is
normal and should just reuse it, not error.

`autoCreateMissingListOptions` (packages/integrations/spira/src/custom-fields.ts) is the
half that actually needs a DB write, so - unlike `resolveCustomFieldValues`, which stays a
pure, transaction-free read so preview can keep calling it - it runs inside each row's own
per-row write transaction (see `runSpiraImport`/`runSpiraTestCaseImport`'s "one
transaction per row" design), right before that row's `createOrUpdate*FromImport` call:
for every list value `resolveCustomFieldValues` couldn't match, it creates the missing
option using Spira's own value text (case preserved) and swaps the new id into that row's
custom field values in place of the `null` it would otherwise have written - so the very
row that first saw an unmapped value is the one that stores it, not just some future
re-import after a human manually adds the option.

The one thing worth getting right here: **don't create the same option twice within one
run**. `autoCreateMissingListOptions` mutates the shared `optionIdByNormalizedText` map on
the run's `CustomFieldMappingResolution` in place as it creates each option, and every
row's `resolveCustomFieldValues` call reads that same shared map - so a value first seen
on row 3 is already a normal match (not "unmatched") by the time row 47 has the same
value, with no second DB round-trip needed for it. `getOrCreateCustomFieldListOption`
itself is still safe even without that (a look-up-then-insert pattern that falls back to
re-looking-up on a unique-constraint conflict), but the shared map is what keeps a big
import from doing a create-or-lookup call on every single row.

`formatUnmatchedListNote` is replaced by `formatAutoCreatedOptionsNote`; the per-row note
now reads e.g. `created new option "Hardware" for "Environment"` instead of "doesn't match
any option - left blank" - informative either way, but now describing something that
actually got fixed rather than something left broken.

Verified with 8 new checks in `scripts/verify-custom-field-import-resolution.ts`: the new
option id lands in the row's resolved custom field values in place of the old `null`;
`autoCreateMissingListOptions` reports what it created (field name + value);
`formatAutoCreatedOptionsNote`'s exact rendered text; the created option is a real row in
`custom_field_list_options`, confirmed by a direct query, not just an id that happens to
be returned; a value auto-created for an earlier row is reused, not recreated, by a later
row with the same value (mapped) in the same run; and a direct count query confirms
exactly one option row exists for a value seen across multiple rows, never a duplicate.
`bun run typecheck` clean, full Docker rebuild clean, all 40 e2e tests still pass.

## Test case import: requirement trace links, unmapped requirements, and progress
  (backlog item 9.26)

Three requests together: import the requirement-coverage links Spira already has when
importing test cases (assuming requirements are imported separately, first), show which
linked requirements couldn't be found locally, and show live progress instead of one
silent blocking call.

**Discovering the trace link.** No existing SpiraClient method covered this, and (same as
backlog item 9.18's entity-id field) no public Inflectra documentation was consulted -
the right endpoint was found by probing several plausible paths directly against the
user's real, already-connected Spira project. `GET /projects/{project_id}/requirements/
{requirement_id}/test-cases` (the requirement-side listing) and `GET /projects/
{project_id}/test-cases/{test_case_id}/requirements` (the test-case-side listing, used
here since importing pages test cases, not requirements) both work and return the same
underlying association rows (`{RequirementId, TestCaseId, RequirementGuid,
TestCaseGuid}`). `SpiraClient.listTestCaseRequirementLinks` wraps the test-case-side call,
returning just the `RequirementId`s - same "one call per test case" N+1 shape as
`listTestSteps`, same reasoning for why that's acceptable at this product's scale.

**Resolving Spira ids to local ones, and reconciling links.** New module
`packages/integrations/spira/src/requirement-links.ts` mirrors the shape of
`custom-fields.ts`'s resolution: `loadImportedRequirementIdMap` loads every requirement
this tenant has already imported from Spira, once per run (not once per row) - backed by
a new generic bulk lookup, `listEntityIdsBySource`
(packages/core/src/external-links.ts), the same "resolve once" idiom
`loadCustomFieldMappingResolution` already established. `resolveRequirementLinks` is a
pure function splitting one test case's Spira requirement ids into locally-matched
(`requirementIds`) and not-yet-imported (`unmappedRequirementIds`).

Writing the link needed a new core primitive: `addTestCaseRequirementLinks`
(packages/core/src/test-cases.ts) is **additive only** - it adds whatever of
`requirementIds` isn't already linked, and never removes an existing link. This
deliberately matches the policy `createOrUpdateTestCaseFromImport` already applies to
steps ("a step missing from the current source payload is left alone, never deleted" -
see backlog item 9's original test-case importer writeup): a link added by hand in this
system, or by an earlier import, must survive a re-import even if the *current* Spira
payload happens not to mention it - silently deleting something nobody asked to remove
isn't safe to do automatically, the same principle already governing every other
reconciliation decision in this importer. `createOrUpdateTestCaseFromImport` gained a
`requirementIds` param (already-resolved local ids, kept Spira-agnostic at the core
layer, same as `customFieldValues`) and now returns `linksAdded`; a link-only change
(title and steps both unchanged) correctly reports `"updated"`, not `"unchanged"` - the
same fix shape as backlog item 9.21's custom-field action-classification bug, applied
proactively here rather than waiting for a user to hit it.

**Surfacing what couldn't be mapped.** "Assume REQs are already created" means this
mechanism only ever *links*, never creates, a requirement - a linked Spira requirement
this tenant hasn't imported yet is real information worth showing, not silently dropped.
Each row's `note` in `TestCaseImportRowResult` says how many and lists them (e.g.
`2 linked requirement(s) not found locally: #931, #988`); `runSpiraTestCaseImport`/
`runOrderedSpiraTestCaseImport` also return a new `TestCaseImportRunResult` shape (`{
rows, unmappedRequirementIds }`) with every such id seen across the *whole* run,
deduplicated and sorted, so the import screen can show one standing summary rather than
requiring someone to read every row's note.

**Progress.** The two run mutations (`run`/`runTestCases`) gained an optional `maxRows`
input, letting the import screen call them repeatedly in small chunks with an advancing
`startRow` instead of one long request the browser just has to wait out. Exposing this
surfaced a real, independent bug worth fixing regardless of the UI: `runSpiraImport`'s
(and `runSpiraTestCaseImport`'s) internal page loop only checked `results.length <
maxRows` *between* full `SPIRA_IMPORT_PAGE_SIZE` (100)-row Spira page fetches - so a
caller-supplied small `maxRows` (say, 20) didn't actually bound how many rows one call
processed; it would still fetch and fully process up to 100 rows before the next check.
Fixed by capping each page's own `numberOfRows` request to `min(SPIRA_IMPORT_PAGE_SIZE,
maxRows - results.length)`, so the very last page fetched (and processed) in a bounded
call is sized to land exactly on `maxRows`, not overshoot it.

For an honest "x/n" denominator, `SpiraClient.countRequirements`/`countTestCases`
(`packages/integrations/spira/src/pagination.ts`'s new `countPagedRows`) page through the
project the *same way* a real run would - capped at the same `maxRows` - so the count a
new `countRequirements`/`countTestCases` tRPC query returns always matches what a run
would actually attempt, not just "however many Spira happens to have". A new
`useChunkedSpiraImport` hook (`apps/web/src/components/spira-import-shared.tsx`) drives
both import screens: fetches the total (best-effort - a failure there just means an
open-ended "x processed" instead of "x/n", not a failed run), then calls the mutation in
`SPIRA_IMPORT_CHUNK_SIZE` (20)-row chunks, accumulating rows and updating processed count
between calls - deliberately *not* built on the mutation's own `isPending`/`data`/`error`,
since those only ever reflect the most recent chunk call, not the whole multi-call run.

One explicit scope cut: the legacy-id (ordered) import mode is excluded from chunking.
`runOrderedSpiraImport`/`runOrderedSpiraTestCaseImport` fetch every row up front and
always restart at row 1 - they have no notion of "resume from startRow" or "just this
chunk" to begin with (a deliberate, pre-existing design choice - sorting requires having
every row first). Chunking that path would silently just reprocess the same first
`SPIRA_IMPORT_CHUNK_SIZE` rows forever rather than ever reaching the rest, so
`useChunkedSpiraImport`'s `unchunked` option makes that mode run as one call (`maxRows`
left unset, the whole project in one request) with indeterminate ("Importing...")
progress instead - functionally identical to how it worked before this change.

**Verified**: 13 new checks in `scripts/verify-test-case-requirement-links.ts`, run for
real against the live dev database -
`loadImportedRequirementIdMap`/`resolveRequirementLinks` against a mix of imported and
never-imported requirements; a link added outside the importer (simulating a person using
the product UI directly) surviving a re-import whose Spira payload reports a completely
different, non-overlapping set of links; a re-import that adds one genuinely new link
correctly reporting both the count and `"updated"`; the final link set confirmed as the
exact union of every requirement ever linked, from every source, by reading the actual
`test_case_requirement_links` rows back through `getEffectiveRequirementLinks`.
`SpiraClient.listTestCaseRequirementLinks`/`countRequirements`/`countTestCases` were also
re-verified directly against the user's real Spira project one more time after wiring
them into the client class (not just as raw HTTP probes) - a known-linked test case
returned its 11 real linked requirement ids, a known-unlinked one returned `[]`, and both
counts matched the project's actual 222 requirements and 71 test cases. `bun run
typecheck` clean, full Docker rebuild clean, all 40 e2e tests passing, plus the two other
Spira-import verify scripts (legacy-id, custom-field-resolution) re-run clean to confirm
the pagination fix didn't regress either.

## Deleting a requirement or a test case (backlog item 9.27)

Prompted directly by the user, right after they'd needed a hand-run SQL fix (subtracting
222 from a real tenant's requirement sequence numbers and its counter, to undo the
numbering gap an earlier bulk-delete-by-hand had left behind) - the natural next ask was
"add an option to delete reqs and tcs" so that kind of cleanup can happen through the app
instead of asking for raw SQL every time.

**Hard delete, not soft.** `requirement-status.ts`'s category list is fixed
(draft/in_review/approved/baselined) - there's no "archived" or "obsolete" concept to
soft-delete into, and building one wasn't asked for and would have been a much bigger
change than "add an option to delete". So `deleteRequirement`/`deleteTestCase`
(packages/core/src/requirements.ts, test-cases.ts) genuinely remove the row, guarded the
same way every other "can I destroy this" decision already works in this codebase - see
`deleteLevelOfKind` (levels.ts), `deleteCustomFieldListOption` (custom-fields.ts), and
especially `deleteEnvironment` (test-environments.ts), whose "count usages, refuse with a
clear message" shape both new functions copy directly.

**Requirement guard: Draft only, and not currently covered.** A requirement that's moved
past Draft represents reviewed, possibly-approved content - `createOrUpdateRequirementFromImport`
already refuses to touch one past Draft rather than silently rewriting it; deleting one
outright gets the identical refusal, for the identical reason. Separately, deleting a
requirement that any test case currently covers (direct link, or via one of that test
case's steps - `getCoveringTestCases`, already existing) is refused too, so a coverage
gap can't appear with no chance to notice - the same "in use, remove it first" rule
already governing level and custom-field-option deletion. `approval_events` needs no
special handling either way: its `entityId` was already deliberately left un-foreign-keyed
to `requirements.id` (matching `audit_log`'s own design - see the original requirement
schema writeup), so it stays resolvable as history regardless of what happens to the
requirement it's about.

**Test case guard: no execution history, period.** Test cases have no versioning/approval
workflow at all (`updateTestCase`'s docstring: "always editable"), so there's no
Draft-equivalent gate - the one thing that matters is whether real evidence exists.
`test_step_executions.test_step_id` already has no cascading delete specifically so a
single *executed step* can't be hard-deleted out from under its evidence
(`updateTestCase`'s docstring: "historical evidence must stay resolvable"); deleting the
*whole test case* has no equivalent protection at the schema level -
`test_executions.test_case_id` **is** a real cascading FK, so without an application-level
check, the database would happily let a delete silently wipe out every execution and
step-result that ever ran against it. `deleteTestCase` counts `test_executions` for the
test case and refuses if there are any, closing that gap the same way the step-level one
was already closed.

**Cleaning up what cascades don't reach.** `external_links` and `custom_field_values` are
both deliberately polymorphic - not foreign-keyed to any single entity table, since they
serve requirements, test cases, *and* test steps from one table each - so a cascading
delete on `requirements`/`test_cases` leaves their rows behind as dangling references.
Left alone, that's a real latent bug: a later re-import of the same Spira id would call
`findEntityIdBySource`, get back a stale entity id, then crash trying to load a row that's
gone (`createOrUpdateRequirementFromImport`/`createOrUpdateTestCaseFromImport`'s own "not
found" errors). Both delete functions clean these up explicitly - for a test case, that
means its own `external_links` row *and* one for each of its steps, which get their own
row when imported (see `createTestCase`).

**What's deliberately left alone: `audit_log`.** Its `entityId` was never foreign-keyed to
begin with (same reasoning as `approval_events` above), so it survives the delete without
any special handling - and a `"requirement.deleted"`/`"test_case.deleted"` entry is written
right before the row goes, capturing the display id and title (formatted while the row
still exists, since neither is look-up-able afterward) into `payload`. This is exactly the
immutable record PRODUCT.md's "Audit Log - immutable record of every state change"
describes: the requirement or test case is gone, but the fact that it existed and was
deleted, by whom and when, isn't.

**UI**: a plain "Delete" button on each entity's own detail page
(`apps/web/src/app/(app)/requirements/[id]/page.tsx`,
`apps/web/src/app/(app)/test-cases/[id]/page.tsx`), guarded by a `confirm()` dialog naming
the item - the same lightweight confirmation this app already uses for deleting a custom
field in Settings, not a new dialog component. Deliberately *not* added to either list
view: deleting stays a one-item, deliberate action taken from the item's own page, not a
bulk operation.

**A pre-existing bug found (not fixed) while verifying this**: writing an e2e test that
actually read `audit_log.payload` back (nothing had, until this) turned up that the
column stores every payload **double-JSON-encoded** - `writeAuditLog` inserts a plain JS
object into a `jsonb` column, but what's actually stored is a JSON *string* containing
the encoded object, not the object itself (confirmed directly: `select payload,
pg_typeof(payload) from audit_log` shows `jsonb` holding `"{\"title\":...}"`, quotes and
all). Harmless in practice so far, since nothing in this app reads `payload` back
anywhere - the e2e tests written for this feature are the very first thing that did - but
it will bite the moment anything does, including the monetization roadmap's own
audit-log export feature. Left as a known issue rather than fixed here, since it's
unrelated to what was asked and touches every audit-writing code path in the app, not
just this one.

**Verified**: 7 new e2e tests in `tests/e2e.test.ts` - real HTTP requests against the
running app, the right verification method here (unlike the Spira-import features, this
is fully reachable over the app's own API, so no separate verify script was needed). A
Draft requirement with nothing covering it deletes and then 404s on a fresh `get`; a
non-Draft one is refused, and is still there afterward to prove it; a covered requirement
is refused until its covering test case is deleted, then succeeds; deleting one writes the
audit entry (parsed past the double-encoding above) and cleans up a directly-inserted
`external_links` row simulating a prior Spira import, confirmed absent afterward by direct
SQL; an unexecuted test case deletes and 404s; an executed one is refused and still there
afterward; a cross-tenant delete attempt on either fails under RLS, confirmed both stay
visible to their real owner. `bun run typecheck` clean, full Docker rebuild clean, all 47
e2e tests pass.

### Follow-up: deleting the tip reclaims its sequence number (backlog item 9.28)

The user's immediate next question after 9.27 shipped: "when deleting the tip, maybe
decrement the ID counter?" - a direct, well-aimed fix for the exact problem their earlier
hand-run SQL (subtracting 222 from a whole level's numbers and its counter, to undo a
gap left by a bulk delete done outside the app) had to work around by hand.

**Only the one safe case.** `decrementSequenceCounterIfTip`
(packages/core/src/level-sequences.ts) gives a number back to the pool *only* when the
item being deleted is still the highest one ever handed out for its (product, level) at
the exact moment of deletion - deleting anything else still leaves the same permanent gap
as before this existed. This is deliberately narrow: not a "find the highest remaining
number and reset to that" scan, and not a multi-step compaction feature - just "undo
handing out this one number", exactly what was asked, and the only case where reclaiming
can't possibly let two different things ever read as the same id later (nothing with a
higher number could have referenced it, since nothing with a higher number exists yet).

**One atomic, conditional UPDATE, not a read-then-write**: `UPDATE
level_sequence_counters SET last_number = last_number - 1 WHERE ... AND last_number =
<the number being deleted> RETURNING last_number`. If some other transaction has already
claimed the next number in between (a real, concurrent possibility -
`nextSequenceNumber`/`ensureSequenceCounterAtLeast` both write to this same row), the
counter has already moved past the number being deleted and the `WHERE` simply matches
nothing - never wrong, only sometimes correctly a no-op. Getting the *detection* of
"did it match" right needed one round of empirical verification: this driver's
`db.execute` returns no row-count metadata at all for a plain UPDATE (confirmed directly -
an empty array either way, matched or not), so the function uses `RETURNING` and checks
whether a row came back, the same technique `nextSequenceNumber`'s own upsert already
relies on for the identical reason.

Wired into both `deleteRequirement` and `deleteTestCase`, right after the row itself is
deleted (a different table, so order doesn't affect correctness, but reads cleanest as
"remove it, then see if its number can be reclaimed"). The outcome
(`numberReclaimed: true/false`) is folded into the same `"requirement.deleted"`/
`"test_case.deleted"` audit payload 9.27 already writes - no separate audit entry, just
one more honest fact captured in the one that already exists.

Verified with 4 new e2e tests (`tests/e2e.test.ts`): deleting the tip and creating a new
item confirms the number is reused, not incremented past it; deleting a non-tip item
(something newer already exists) confirms the gap stays permanent, unreclaimed; two
consecutive tip deletes confirm the counter walks back one step at a time, not just once;
the identical reclaim behavior confirmed for test cases too. `bun run typecheck` clean,
full Docker rebuild clean, all 51 e2e tests pass, plus the other sequence-counter-touching
verify scripts (legacy-id import, test-case-requirement-links) re-run clean.

## Templated PDF document generation (backlog item 9.29)

User-definable HTML+Handlebars templates, generating a PDF per test case, per test
execution, or per a currently-shown list of requirements, with tenant-defined
fill-in-at-export-time parameters. Nothing generated is ever stored - it exists only in
the HTTP response, downloaded once and gone.

### PDF engine: wkhtmltopdf, not a headless browser

The obvious default for "render HTML to PDF" in 2026 is Puppeteer or Playwright, and that
was the plan going in - but the user pushed back immediately and specifically: "I would
hate the headless chrome, it's slow and flaky", naming DinkToPdf (a .NET wrapper) as what
they'd used successfully before. DinkToPdf wraps wkhtmltopdf - so that's what this uses,
and it's a materially different shape of tool: a one-shot CLI conversion (HTML in, PDF
out via two temp files - see below), not a browser automation session with a page
lifecycle, navigation events, and a process that can hang or leak. That's also most of
why it was chosen over the "lightweight pure-JS PDF library" alternative that was on the
table (pdf-lib/pdfkit-style structured layout, no HTML rendering at all) - the templates
need to render the same rich-text HTML (tables, bold, lists) already used throughout
requirements and test steps, and wkhtmltopdf renders real HTML+CSS natively where a
structured-layout library would need the rich text flattened to plain text, a real
fidelity loss.

Not available via Debian's own apt repos (dropped from recent releases, since it depends
on an unmaintained patched WebKit/Qt fork it can't get from Debian's own Qt packages) -
installed instead from the official `wkhtmltopdf/packaging` GitHub release build, a
statically-linked package with its own Qt/WebKit bundled in. Confirmed directly rather
than assumed: installed and ran a real HTML→PDF conversion inside the *exact* base image
this project already uses (`oven/bun:1`, which turned out to be Debian 13 "trixie") before
committing to it in the Dockerfile, and it's ~80-100MB added to the image versus the
300-400MB+ a bundled Chromium would have cost.

### Two real bugs, found by actually running it, not by trusting it would work

Both were only found because generation was tested for real, locally, rather than judged
"probably fine" from a clean container test alone - exactly the "verify for real" habit
this project has leaned on throughout (see, e.g., 9.22's `readSpiraField` bug, also only
found by testing against real data rather than a shape-matching mock).

1. **Stdin/stdout piping is the less reliable of the two I/O modes for this binary under
   Bun.** `wkhtmltopdf - -` (HTML on stdin, PDF on stdout) failed specifically when
   invoked through Bun's subprocess pipes (`QPainter::begin(): Returned false`), while
   the *identical* conversion succeeded immediately once file-based I/O replaced it (HTML
   written to a temp file, wkhtmltopdf given two file paths, PDF read back from the
   output file). This isn't just a workaround for one local reproduction - file-based
   invocation is also the long-established, most battle-tested way production
   wkhtmltopdf wrappers in every other ecosystem already do this (PHP's `snappy`, most
   Node wrappers, .NET's DinkToPdf itself).
2. **A real desktop session breaks it, invisibly, until you actually have one.** Run with
   this process's *actual* environment (`DISPLAY`, `WAYLAND_DISPLAY`, several `QT_*`
   variables - all inherited, exactly what any developer's own machine has, and what a
   clean Docker container never does), wkhtmltopdf's "patched Qt" tried to use that real
   display and failed the same way. Fixed by spawning with a minimal, explicit allow-list
   environment (`PATH`/`HOME`/locale only) rather than `{...process.env}` - which is
   better hygiene regardless of this specific bug, since this server process's own
   environment (`DATABASE_URL` and everything else) has no legitimate reason to reach an
   external binary being fed arbitrary, template-rendered HTML.

Both live in `packages/documents/src/index.ts`'s `renderPdf`, alongside `renderTemplate`
(a pure Handlebars compile+render, no I/O - kept separate so a future "preview as HTML"
feature, or just testing template logic, doesn't need the PDF binary at all).

### Schema, core, and the raw generation route

`document_templates` (scope - `'test_case' | 'test_execution' | 'requirement_list'` -
name, html_template) and `document_template_parameters` (`key`, the plain identifier a
template body actually references as `{{params.<key>}}`, deliberately kept separate from
the human-readable `label` shown on the export-time fill-in form - a wording tweak to the
label never breaks a template that already references the key). Both tenant-isolated by
RLS (migrations 0013 drizzle-generated / 011 manual, same split as every other feature
here).

`packages/core/src/document-templates.ts` owns CRUD (mirroring `custom-fields.ts`'s
shape closely - sort order, `isUniqueViolation`-based friendly duplicate-name errors).
`packages/core/src/document-context.ts` builds the Handlebars context per scope -
`buildTestCaseDocumentContext`, `buildTestExecutionDocumentContext`,
`buildRequirementListDocumentContext`. The requirement-list one deliberately takes an
explicit `requirementIds: string[]` rather than re-deriving "everything in this level"
server-side from a set of filter parameters: the requirements list page already computes
exactly the filtered/sorted set it's showing (client-side, over the whole level's
data - see backlog item 9.14's URL-state-driven filtering), so the "Generate document"
button there just reads that same array and sends it along, rather than this becoming a
second filter implementation that has to be kept in sync with the first one forever.
Evidence (uploaded files on a step execution) is listed by filename only in the
test-execution context, not embedded as images into the document - a deliberate,
documented scope cut, easy to add later without changing anything else here.

Generation itself (`POST /api/documents/generate`) is a raw Next.js route, not a tRPC
procedure - it returns a binary PDF (`Content-Type: application/pdf`,
`Content-Disposition: attachment`), the same reasoning `/api/attachments/*` already
established for binary responses. Body shape depends on the template's own scope
(`testCaseId`, `executionId`, or `requirementIds`+`productId`+`levelId`); a missing
required parameter, an unresolvable requirement id, or a template belonging to a
different tenant are all refused with a clear message rather than generating a partial or
wrong document.

### UI

New `/settings/document-templates` page: per-scope template list, an inline HTML-template
editor with a static placeholder-reference block for that scope (what fields are
available, not dynamically computed - simplest thing that's still genuinely useful), and
parameter management - the same structural shape as `/settings/custom-fields`
(reorder/rename/delete, add-new-row-at-the-bottom form). A shared `GenerateDocumentButton`
component (`apps/web/src/components/generate-document-button.tsx`) is wired into the test
case page, the test execution page, and the requirements list (reading its already-
filtered row set directly) - it renders nothing at all when a tenant hasn't defined any
template for that scope yet, so a page with no templates configured looks exactly like it
did before this feature existed.

One thing worth being deliberate about again here: `packages/documents` uses Bun-only
APIs (`Bun.spawn`, `Bun.file`) and must never be imported from a client component - the
same client-bundle-contamination risk this project hit before with `@galm/core`'s
`@galm/db` dependency (see backlog item 9.12's writeup). Confirmed by checking the actual
Docker build output: no client page bundle grew in any way that would suggest it pulled
in a server-only dependency.

### Verified

7 new e2e tests in `tests/e2e.test.ts` - fully reachable over the app's own HTTP surface
(unlike the Spira-import features, which need a live or mocked external server), so no
separate verify script was needed. All three scopes generate a real PDF, checked for the
literal `%PDF-` magic bytes rather than just a 200 status, run against the *actual*
rebuilt Docker image's real wkhtmltopdf install; a missing required parameter is refused
naming it; a requirement list including a nonexistent id is refused rather than silently
generating a partial document; template create/rename/update/delete works and deleting a
template cascades its parameters; a duplicate parameter key on one template is rejected;
cross-tenant generation is refused under RLS; generating with no session is 401. Also
verified directly outside the test suite: `wkhtmltopdf --version` and a real conversion
via `docker exec` into the actual running container, not just during the image build.
`bun run typecheck` clean, full Docker rebuild clean, all 58 e2e tests pass.

### Follow-up: live template preview (backlog item 9.30)

The user's immediate next ask, right after 9.29 shipped: a rendered preview to the right
of the HTML editor, updating as the template changes, against a real example (a test
case picked by the user, for the test-case scope; an execution or a product/level's
requirements for the other two).

**Deliberately HTML-only, not a real PDF-per-keystroke.** `renderPdf` shells out to
wkhtmltopdf - a real subprocess per call, entirely reasonable for one deliberate
"Generate" click, far too slow and wasteful to run on every keystroke of a live preview.
The preview calls `renderTemplate` alone (the pure Handlebars step, already split out of
`renderPdf` for exactly this reason - see that function's original docstring, which
already anticipated "a future 'preview as HTML' feature"), then wraps the result in the
same default-document skeleton `renderPdf` applies via `ensureHtmlDocument` - now
exported from `@galm/documents` rather than kept private, so a body-fragment template
(the common case: just a heading, some paragraphs, a table, no `<html>` of its own)
previews with the same default styling the real PDF would actually get, not a plainer
unstyled version. The one honest gap: wkhtmltopdf's own rendering engine (an older
WebKit) can differ slightly from the iframe's browser engine for complex CSS - a real
but narrow gap for the plain document-style layouts these templates are meant for.

**New `documentTemplates.previewHtml` tRPC mutation** (JSON in, JSON out - unlike actual
generation, this never touches wkhtmltopdf, so it doesn't need the raw-route/binary-
response treatment `/api/documents/generate` does). Takes the template's id (to load its
already-saved parameter *definitions* - required-ness, type) plus the current, possibly
unsaved, editor draft as an explicit `htmlTemplate` override, so what's rendered is what's
actually on screen right now, not whatever was last saved - the same "reflects live
state, not persisted state" property the editor's own dirty-tracking already has.
Deliberately more lenient than the real generate route in one specific way: a missing
*required* parameter doesn't fail the whole preview, it just renders empty - a preview
that hard-errored on the very first character typed into a form with a required
parameter would be far less useful than one that just shows the gap.

Two new lightweight listing queries back the example picker for the scopes with no
natural "pick from the current page" source: `listExampleTestCases` and
`listExampleExecutions` (both capped at 30, newest-first - no existing query lists across
every product, since every other list in this app is deliberately scoped to one
product+level at a time, e.g. `testCases.listByProduct`-style calls). The
requirement-list scope needed no new query at all - it reuses the already-existing
product/level pickers and `requirements.listByProduct`, with the client capping the
example to the first 5 requirements so the preview stays a representative sample rather
than rendering an entire level's worth of rows into a small preview pane.

**UI**: the "HTML template" section of `/settings/document-templates` became a two-column
grid (editor left, preview right - stacking to one column below the `lg` breakpoint, same
responsive convention as everywhere else in this app). The preview pane shows the example
picker, small inline inputs for each of the template's parameters (independent, testing-
only state - not the same values a real export would use), and a sandboxed
`<iframe srcDoc={html} sandbox="">` - full sandboxing (no scripts, no same-origin access)
is cheap defense-in-depth for rendering a tenant's own arbitrary HTML, even though the
realistic risk here is a tenant admin editing their own template, not a third party.
Debounced ~500ms via a `useEffect`/`setTimeout` pair keyed on the draft HTML, the chosen
example, and the preview parameter values - not on every individual keystroke's
synchronous render.

**Verified**: 6 new e2e tests in `tests/e2e.test.ts` - no example selected returns
`{ html: null, error: null }` (a neutral, not-yet-ready state, never a hard failure); the
preview genuinely reflects the current draft (a template edited to say "DRAFT VERSION"
shows that, not the still-saved "SAVED VERSION"), and is wrapped in a full document
skeleton (`<!DOCTYPE html>`, `<html>`) confirming `ensureHtmlDocument` ran; a filled-in
parameter substitutes correctly while an unfilled required one renders blank instead of
erroring the whole preview; all three scopes render real content pulled from a real
example entity; the two new example-listing queries return real, existing rows; a second
tenant's test cases never appear in tenant A's example picker, confirmed under RLS.
`bun run typecheck` clean, full Docker rebuild clean, all 64 e2e tests pass.

## Filename templates, and bulk generation as a zip (backlog items 9.31/9.32)

Two requests back to back: "template should allow to specify filename format", then
"allow to select a bunch of test cases/executions and create separate reports for all of
them... download in one zip". The first landed at exactly the right moment for the
second - without it, every file in a bulk zip would have shared the template's one
static name.

### Filename templates (9.31)

New nullable `document_templates.filename_template` column - Handlebars again, rendered
against the identical context the body renders against, so a filename can reference the
same fields (`{{displayId}} - {{title}}`). `renderFilename`
(`packages/documents/src/index.ts`) is deliberately not just `renderTemplate` reused
as-is: escaping is off (`noEscape: true`) since a filename isn't HTML - a literal `&` in
a title has no business becoming `&amp;` - and the result goes through a
filesystem-safety pass afterward (strip `\ / : * ? " < > |` and control characters,
collapse whitespace, cap at 150 characters). Falls back to the template's own `name` if
the field is unset (nullable column, no backfill needed for a template that predates
this) or if rendering throws for any reason (a typo'd placeholder shouldn't block
generation entirely - a less-ideal filename beats no file at all).

New templates are seeded with a sensible per-scope default (`{{displayId}} - {{title}}`
for test cases, similar for the other two scopes) rather than shipping with the old
static-name default and leaving the operator to discover the filename field exists at
all. The live preview (backlog item 9.30) renders the example filename right alongside
the HTML, on the same debounce - "as you make changes" now covers both halves of what a
downloaded file actually looks like.

### Bulk generation, zipped (9.32)

New `POST /api/documents/generate-bulk`, structurally the sibling of
`/api/documents/generate` - both now call into a new shared module,
`apps/web/src/server/document-generation.ts`, for the actual per-target work (build the
right context for the template's scope, render, convert to PDF, name the file). This
existed only inline in the single-document route before; factoring it out here isn't
just avoiding duplication for its own sake - two routes independently reimplementing
"what does a `test_execution` context need" were guaranteed to drift apart eventually,
and this makes that structurally impossible.

Deliberately scoped to `test_case`/`test_execution` templates only - a
`requirement_list` template already produces one combined document for a whole list of
requirements in a single call to the existing non-bulk route (backlog item 9.29's own
"whatever a requirements list currently shows" design), so "bulk, one file per selected
item" isn't a meaningful concept there the way it is for a batch of individual test
cases or runs.

**Zipping**: a new `zipFiles` helper (`@galm/documents`), backed by `jszip` - a pure-JS
library, unlike wkhtmltopdf. That's not an inconsistency in this project's "avoid another
external binary dependency" instinct: writing a well-defined container format needs no
rendering engine at all, so a plain library is genuinely sufficient here, not a corner
cut the way a JS-only *PDF* renderer would have been for HTML with real CSS. Duplicate
filenames within one batch (two targets whose filename template happens to render
identically - two executions of the same test case, say) are disambiguated by
`zipFiles` itself (" (2)", " (3)", ...), never one entry silently overwriting another.

**Partial failure, the same principle as every importer in this codebase**: a bad target
doesn't abort the whole batch - it's collected and, if anything else in the batch
succeeded, surfaced as an `errors.txt` entry inside the returned zip rather than
vanishing with no trace. Only when *every* target fails does the route return a plain
JSON error instead of a zip with nothing useful in it. A parameter (e.g. "Prepared by")
is resolved once for the whole batch, not once per target - filling in the same value
for every generated file is the realistic case, not a value that varies file-to-file. A
sanity cap (100 targets per request) refuses an accidentally-huge selection before any
per-target work starts, rather than timing out partway through generating dozens of
PDFs.

**UI**: checkboxes on the test cases list (`test-cases-section.tsx` - a "select all
visible" header checkbox plus per-row, independent of whatever filters are active, same
"selection survives a filter change" choice made for consistency) and on a test case's
own execution history list (each row is normally one big clickable `<Link>` to that
execution; the checkbox now sits outside it so a click there doesn't also navigate). A
new `BulkGenerateDocumentButton` (template picker, parameter inputs, one "Download N
reports (zip)" button) renders only once a selection is non-empty, mirroring
`GenerateDocumentButton`'s "render nothing until there's something to act on" behavior.

**Verified**: 11 new e2e tests across both features. For 9.31: the filename renders and
sanitizes correctly into `Content-Disposition`; an unset filename template falls back to
the template's own name; `updateFilename` both sets and clears it. For 9.32: bulk
generation for test cases and for executions each produce one correctly, distinctly
named zip entry per target - read directly out of the real returned zip bytes via a
small hand-rolled local-file-header parser added to the test file itself (a filename is
stored uncompressed in its entry's header regardless of the entry's own compression
method, so this is a real read of the actual bytes, not a mock, without needing a
zip-parsing library as a dependency of `tests/`, which isn't a workspace package);
colliding filenames within one batch get disambiguated; a partially-failing batch
returns the successes plus `errors.txt`; an entirely-failing batch returns a JSON error
rather than an empty zip; the wrong id array for a template's scope, a
`requirement_list` template, and exceeding the 100-target cap are all refused with clear
messages; a cross-tenant target is refused under RLS as a per-item failure. `bun run
typecheck` clean, full Docker rebuild clean, all 75 e2e tests pass.

**Superseded by backlog item 9.34, directly below**: the "returns a JSON error rather
than an empty zip" behavior for an all-targets-failed batch, and the plain
`Content-Type: application/zip` response shape described above, both changed once bulk
generation started streaming progress - see 9.34 for why and what replaced them. The
zip-generation logic itself (`zipFiles`, filename dedup, `errors.txt` for a partial
failure) is untouched; only how the *result* travels back to the browser changed.

## "Export documents" wording, and real progress for bulk exports (backlog item 9.34)

Two pieces of direct user feedback landed together: rename "generate reports" language
to "export documents" throughout (a wording-only change, not covered further here), and
add a progress indicator for bulk exports, since generating several PDFs in a row can
take a visible moment with nothing on screen to show it's working.

### Real progress, not a simulated one

The honest options for "show progress on a long-running server operation" were: fake it
(a progress bar driven by an estimated duration, not by what's actually happening), or
have the server report real progress as it goes. A simulated bar was never seriously
considered - it can silently diverge from reality (finishing early and sitting at 90% for
several seconds, or the reverse), which is worse than no progress bar at all for
something the user might come to rely on ("is it stuck?").

Real progress needs the response to arrive incrementally, not as one atomic result -
`/api/documents/generate-bulk` now streams **newline-delimited JSON**: one
`{"type":"progress","done":N,"total":M}` line the moment each target finishes (success
or failure - both count as "done" for progress purposes, matching how the wizard's own
progress bar reads them), then exactly one final line - `{"type":"done", filename,
zipBase64}` on success, or `{"type":"error", message}` if every target failed. The
finished zip travels **base64-encoded inside that last JSON line**, not as raw bytes
appended after some text/binary boundary in the same stream. That's a real, deliberate
size cost (roughly a third larger than the raw bytes) - accepted because it means every
single line in the response is valid, ordinary JSON with no exceptions, so parsing it is
just "split on newline, `JSON.parse` each complete line" with no binary-framing edge
cases (a chunk boundary landing mid-multi-byte-sequence, knowing exactly which byte the
text portion ends and the binary portion begins) to get subtly wrong. Reports at this
product's scale don't make the overhead meaningful either way.

**One architectural consequence worth being explicit about**: once the stream has
started, the HTTP status code is already committed (200, sent with the first byte) - an
"every target failed" outcome discovered partway through can no longer become a 4xx
response, the way the pre-streaming version of this route (backlog item 9.32) used to
signal it. It's the in-stream `"error"` line instead now. This only affects outcomes that
can only be *known* once generation has started; every validation check that can be
decided before any generation work begins - a missing/bad `templateId`, the wrong scope
for bulk generation at all, the wrong id array for the template's scope, more targets
than the 100-item cap - still happens before the stream opens and is completely
unaffected, still a normal non-200 JSON response exactly as before.

A smaller, easy-to-miss fix rode along with this rewrite: the whole batch used to run
inside one shared `withTenant` transaction; now each target gets its own, opened fresh
inside the streaming loop. This isn't a new architectural principle - it's the *exact*
reasoning `runSpiraImport`'s own docstring (backlog item 9) already spells out for why a
single big-batch transaction is the wrong shape (lock contention held for the whole
run's duration, and Postgres aborting an entire transaction after any one failed
statement inside it, which breaks per-target error isolation) - it just hadn't been
applied here yet, and rewriting this route's body was the natural moment to fix it
rather than carry the same latent issue forward into the new version.

### The client side: a manual stream reader, not `res.json()`

`DocumentGenerationWizard` (backlog item 9.33) gained a `streaming` prop. When set, it
reads the response with `response.body.getReader()` in a manual loop - not `res.json()`
or `res.blob()`, both of which wait for the entire response to finish before returning
anything, defeating the entire point of a live progress signal. Each chunk is decoded
and buffered; every complete `\n`-terminated line found in the buffer is parsed and
dispatched immediately - a `"progress"` line updates a `{ done, total }` state (rendered
as a plain `<progress>` element plus "Exporting N of M..." text), a `"done"` line
base64-decodes its zip and triggers the download, an `"error"` line throws to the same
error-handling path a failed single-document export already uses. The non-streaming path
(`GenerateDocumentButton`, one document, no discrete steps worth reporting on) is
untouched - it still just awaits the whole response and downloads it, no reader loop
needed for something that's already fast and atomic.

**Verified**: the existing bulk e2e tests (backlog item 9.32) were updated to assert on
the new protocol rather than left passing against assumptions the rewrite invalidated -
a successful run now checks the *actual sequence* of progress events the server emitted
(`[{done:1,total:2},{done:2,total:2}]`), not just the final zip's contents; the
all-targets-failed case confirms the one target still produced a `{done:1,total:1}`
progress event before the final error line (so a real user watching the progress bar
sees it reach the end, not hang at 0); the partial-failure, filename-collision, and
cross-tenant cases were all re-verified against the new response shape. `bun run
typecheck` clean, full Docker rebuild clean, all 75 e2e tests pass.

## Bug: a completed export triggered its own "leave this page?" prompt (backlog item 9.36)

Reported right after 9.34/9.35 shipped: exporting a document worked, but immediately
afterward a confirm box appeared asking to leave the page, and clicking Cancel on it
silently skipped the download. The confirm text was the giveaway once looked at
carefully - it read "An export is in progress - leaving this page will cancel it. Leave
anyway?", which is `useUnsavedChangesGuard`'s wording (reused wholesale by
`useExportDialogGuard` for the real "don't lose an export by navigating away" case), not
`confirmClose`'s own "An export is in progress. Cancel it?" from the dialog-close guard.
So the bug wasn't in any of 9.35's new dialog-close machinery at all - it was the
*existing*, previously-fine `useUnsavedChangesGuard` hook firing on a click it was never
meant to see.

**Root cause**: `DocumentGenerationWizard` downloads a finished export by building a
temporary `<a href="blob:...">…</a>` with a `download` attribute, appending it to the
document, and calling `.click()` on it - the standard trick for saving a client-side
`Blob` with no server round-trip. `useUnsavedChangesGuard` installs a capture-phase
`click` listener on `document` that treats *any* clicked anchor with a same-page `href`
as "the user is navigating away" and, while `isDirty` (here, `isGenerating`) is true,
intercepts it with a `confirm()`. At the instant the synthetic download anchor is
clicked, `isGenerating` is still `true` (cleared a few lines later, after the download
has fired) - so the guard fired on its own click, and browsers only carry out an
anchor's default action if the click event survives without `preventDefault()`.
Declining the guard's prompt calls `preventDefault()`, which killed the download along
with the (nonexistent) navigation.

**Fix**: teach `useUnsavedChangesGuard`'s click handler that a `download` anchor never
navigates the page away, so it's categorically exempt - `if (anchor.hasAttribute
("download")) return;`, one line, before the existing `href`/`target="_blank"` checks.
This fixes it for every current and future caller of the shared hook, not just the
document-export wizard, and needed no changes at all to the wizard's own download code.

Two more, unrelated hardening changes were made while chasing this down - real
correctness improvements, but confirmed (via the browser reproduction below) **not** to
have been the actual cause, so listed here mainly so a future reader doesn't have to
re-derive whether they still matter: `generate()` now clears `isGenerating` (and
`abortControllerRef`/`progress`) *before* calling the caller's `onGenerated()` rather
than after, so a caller that closes the dialog from `onGenerated` never sees a stale
"still generating" flag; and `useExportDialogGuard`'s `confirmClose` now reads a
`useRef`-backed mirror of `isGenerating` rather than the state closure, since a
synchronous `onOpenChange` can in principle fire before React commits a state update. A
third hypothesis chased first - that the synthetic anchor's click was being mistaken for
an "outside click" by the `Dialog` primitive itself, worked around by appending the
anchor inside the dialog's own popup DOM - was reverted once the real cause was found;
keeping it would have been shipping a fix for a bug that didn't exist.

**Verified for real, in a real headless browser** - this is an interactive DOM/event-
timing bug that this project's e2e suite (real HTTP requests via `fetch`, no browser)
structurally cannot observe, so `playwright` was installed one-off (matching the
Chromium build already cached for this machine's user, not added as a project
dependency) and used for two not-committed scripts against the actual rebuilt Docker
stack:
- Registered a tenant, created a template and test case via the real API, drove a real
  page through the export dialog, clicked Export, and asserted - via `page.on('dialog',
  ...)` and `page.waitForEvent('download')` - zero unwanted native prompts and a genuine
  download. Run against the pre-fix build this reproduced the exact reported bug (the
  same confirm text, the download never firing); run again post-fix it passed clean.
- A second script delayed the `/api/documents/generate` response and pressed Escape
  mid-export, confirming the *legitimate* 9.35 "cancel this export?" prompt still
  appears and still works - proof the fix didn't overcorrect and swallow that one along
  with the spurious one.

`bun run typecheck` clean across the whole project, full Docker rebuild, all 75 e2e
tests still pass (no server-side behavior changed, so no regression expected there, but
re-run anyway rather than assumed).

## AI-assisted test step drafting (backlog item 9.37)

A chat-style "Draft with AI" button on a test case's Steps section: tell it what to do
(free text, can reference requirements including ones just added to the product), it
proposes a full replacement step list shown as a diff, and you refine (another
instruction) or accept (replaces the editor's real step list - the page's own,
pre-existing Save button is still what persists anything).

**Provider abstraction, and why the Vercel AI SDK specifically**: the user's own words
when scoping this were "I don't want to commit to Claude code, I want it to be more
generic" and "would I need a Vercel account?" - both real constraints. Landed on the
Vercel AI SDK (`ai` + `@ai-sdk/anthropic`/`openai`/`openai-compatible`) partly because a
second, not-yet-built feature this was scoped alongside ("generate a template from an
uploaded PDF") wants multimodal input, which a hand-rolled OpenAI-wire-shape client
(this codebase's usual plain-`fetch` style, e.g. `packages/integrations/spira`) doesn't
solve for free across vendors. Confirmed with the user that this needs **no Vercel
account or hosted gateway** - each `@ai-sdk/*` package calls that provider's own API
directly with a key the tenant supplies. `resolveModel` always constructs an explicit
provider instance (`createAnthropic(...)(modelId)`, etc.) and hands that object to
`generateObject`, never a bare model-id string - a bare string is what routes through
`ai@7`'s own built-in `@ai-sdk/gateway` provider, deliberately never reachable here.

**"OpenAI-compatible" as the generality escape hatch**: rather than an `@ai-sdk/*`
package per vendor, a single `openai_compatible` provider option takes a custom
`baseURL` and covers self-hosted endpoints (Ollama, vLLM) and third-party
OpenAI-shaped APIs (Groq, Together, DeepSeek) with one code path.

**Credentials**: new `llm_connections` table, one row per tenant, a close mirror of
`spira_connections` and its CRUD conventions - key never echoed back, empty key on
re-save keeps the existing one, same documented plaintext-storage trust boundary as
every other credential here (no KMS layer exists yet). `provider` is DB-CHECK-
constrained; `model` is free text, not an enum - providers rename/add models faster than
this app could track.

**The diffing contract - real content comparison, never trusted from the model's own
claims**: the system prompt has the model return the *complete* resulting list every
turn (never a delta at this point), copying a step's client-generated `key` verbatim
when unchanged, keeping it when modifying, using `key: null` only for a genuinely new
step - so "a step the model didn't mention" is never an ambiguous state. The actual diff
(`step-diff.ts`'s `diffProposedSteps`) is computed client-side by that same key -
by-key matching, then normalized-HTML comparison to tell "modified" from "unchanged" -
never by trusting what the model claims about its own edit. An unmatched key is
defensively treated as `added`, never crashes. The baseline is fixed for the whole
dialog session, so every refinement's badges answer "what would change relative to
what's really in the editor now," not "since the last message."

**A real security gap, found and fixed during implementation**: the diff preview
renders proposed HTML via `RichTextView`, which assumes its input already passed
`sanitizeRichText` - true for every other caller, but this feature's HTML comes
straight from the model and had never been through that sanitizer before an *unaccepted*
proposal renders. A malicious or compromised endpoint (realistically: a self-hosted
`openai_compatible` connection) could return a script tag or `onerror` attribute that
executes before Accept is ever clicked. Fixed by sanitizing every proposed step
server-side, inside `suggestSteps`, before the response reaches the browser - saving
still re-sanitizes on accept regardless, so the one-sanitize-choke-point invariant holds
everywhere.

**Testing an external paid API without ever calling it**: `resolveModel` has one
doubly-gated escape hatch - a connection whose `baseUrl` is the sentinel
`mock://step-suggestions` *and* `ALLOW_MOCK_LLM_PROVIDER=1` together select `ai/test`'s
`MockLanguageModelV4`, imported lazily so a real request path never loads it. No
`"mock"` value exists in the DB CHECK or settings UI. The mock sniffs the prompt for
sentinel substrings to drive specific branches, and for the default case **parses the
real baseline step's key back out of the prompt** rather than using a hardcoded fake
one - the first attempt used a fake key, and a real-browser smoke test immediately
caught the consequence: since a real key is a UUID, the fake one never matched, the
diff correctly classified the row as `added` rather than `unchanged` (correct diff
behavior - a flaw in the mock, not the product), and accepting it silently dropped the
original step's content. Fixed by having the mock echo the real key back, which is what
a real, well-behaved model would do anyway.

**Verified for real, in multiple layers**: `bun run typecheck` clean across all
packages including the new `packages/integrations/llm`; a Docker rebuild that genuinely
failed on the first attempt (the Dockerfile only `COPY`'d the existing integration
package's `package.json`, not the new one - a real caught bug, not hypothetical); the
migration applied and confirmed via `\d llm_connections` against the live container;
the e2e suite (6 new tests) passing alongside the pre-existing 75. Because this is
fundamentally an interactive chat-dialog feature the HTTP-only e2e suite can't exercise,
a real headless-browser smoke test (Playwright, one-off) drove the actual dialog end to
end - and is what caught the mock-key bug above before it shipped. Whether a *real*
provider's suggestions are good is not something automation can assert.

## AI step drafting: delta output instead of the full list every turn (backlog item 9.42)

The original design (9.37) had the model return the *complete* resulting step list on
every turn, including every unchanged step, so "a step not mentioned" would never be an
ambiguous state for the diff to interpret. Sound reasoning, but it meant regenerating
every untouched step's full HTML verbatim just to say "this one's the same" - a
one-step edit on a case with many steps paid full output-token cost every turn. The
user noticed directly ("it uses a lot of tokens") and asked whether outputting only
added/modified steps would help.

**The redesign**: the response became a delta - `{ summary, upserts: ProposedStep[],
removedKeys: string[] }` - instead of a full list. `upserts` holds only new or actually-
changing steps; `removedKeys` holds keys to delete; anything unmentioned automatically
stays as it is. The old ambiguity doesn't return: an unmentioned step now has one
unambiguous meaning (unchanged) by construction, just not spelled out explicitly.

Reconstructing the full list for the diff/accept UI (`diffProposedSteps`/
`acceptProposal`, unchanged by this) is now a small, free, client-side merge -
`applyStepDelta(current, delta)` - not something the LLM has to do. `current` is the
resulting list from just before this turn: the editor's own steps for a conversation's
first message, or the previous turn's merge result for a refinement.

**A structural side benefit, not just a cost one**: 9.41's false-positive "modified" bug
existed because the model, asked to reproduce an unchanged step "verbatim," would
introduce incidental reformatting that a byte-level comparison had to be taught to see
through. Under the delta contract, an untouched step is never regenerated at all - that
failure mode becomes structurally impossible for any step the response doesn't mention,
not just harder to hit. 9.41's normalization stays as real defense-in-depth for steps
the model *does* touch.

**New steps need a real key the moment they're proposed, not just once accepted.** In
the old design this didn't matter - an unaccepted new step was fully regenerated every
turn regardless. Under the delta contract, a refinement like "reword the step you just
added" needs a real, stable key to reference before anything's accepted.
`applyStepDelta` now assigns one (`crypto.randomUUID()`, same mechanism `acceptProposal`
already used at final accept) the instant a new step is merged in, echoed back as part
of `previousProposal` on the next request.

**The honest trade-off**: the old design let the model freely reorder the whole list
(e.g. "swap steps 2 and 3"). The delta contract carries no ordering signal - a modified
step stays put, a new one appends at the end. Free-form AI-driven reordering is lost;
manual reordering (the step editor's own up/down buttons) still works. Reordering
wasn't already a first-class diff feature (no "moved" badge - see 9.39), so this was
judged an acceptable trade for the token savings.

**Deferred, recorded so it isn't re-litigated later**: prompt caching (real *input*-
token savings on refinement turns, since the requirement list and instructions repeat
verbatim, but provider-specific complexity); capping resent history to the last few
turns instead of the whole chat; on-demand/tool-call-style requirement fetching instead
of sending up to 300 requirements' full text every turn (the biggest remaining
input-token win for large products, but a genuine multi-round architecture change).

**Verified for real, and the first real-browser run caught an actual bug before it
shipped.** The mock's branches had carried over the old design's habit of every
response also adding an unrelated step - under the new contract, a two-turn Playwright
script ("add a step" on a 3-step case, then a refinement) came back with 5 diff rows on
turn 2 where only 4 were expected. Not an app bug - a stale assumption in the mock -
fixed by making each branch perform exactly one delta operation. After the fix: turn 1
rendered exactly 1 added + 3 unchanged; turn 2 rendered 1 added (still present, not
duplicated) + 2 unchanged + 1 modified with a genuine Before/After - proving the
multi-turn flow, including the new-step-gets-a-key mechanism, holds end to end.
`step-diff.test.ts` gained 6 new unit tests (including the exact "add then refine that
same new step" scenario); the e2e suite gained a remove-branch test and tightened
modify-branch assertions. `bun run typecheck` clean, full Docker rebuild, all 83 e2e
tests pass (82 prior + 1 new), all 22 unit tests pass (16 prior + 6 new).

## AI step drafting: real positioning, and step numbers in the diff (backlog item 9.43)

9.42's delta redesign explicitly flagged, as an accepted trade-off, that a new step
would only ever append at the end. Real usage disagreed: "it added 2 steps in the
middle, but they ended up at the end." A trade-off that looks reasonable on paper can
still turn out wrong in practice - the fix here is that correction, not a reversal of
the delta design itself (upserts/removedKeys still carry no position information; a new,
optional field handles position specifically).

**The `order` field**: `stepSuggestionResultSchema` gained `order: z.array(z.string()
.nullable()).optional()` - the complete final sequence of step keys, real keys for
existing steps, `null` as a placeholder for each new step from `upserts` (matched
positionally). Optional and omitted for the common case - a pure content edit pays
nothing extra; a new step still defaults to the end, unchanged from 9.42. The system
prompt is explicit that `upserts`/`removedKeys` alone never change order, and that
`order` is required whenever a new step belongs somewhere other than the end or
existing steps need reordering.

**`applyStepDelta` resolving `order`**: content updates happen first, unchanged; `order`,
when present, then decides final position by walking its entries, resolving each real
key against the content-updated list and each `null` against the next new step in
sequence. Two defensive fallbacks, matching this feature's "never trust the model,
never crash, never silently lose data" posture: an unknown/hallucinated key in `order`
is simply skipped; any step still present that `order` didn't mention is appended at the
end rather than dropped - the same pre-9.43 fallback, so a partially-wrong `order`
degrades toward "looks like 9.42" rather than data loss.

**Step numbers in the diff - a feature that fell out of doing this properly, not a
separately-designed one**: `diffProposedSteps` now computes `position` (where a step
ends up in the resulting list) and `originalPosition` (where it was in the baseline) on
every row. The panel renders "Step N", "Was step N" for a removed row, and - once both
are tracked for real - "Step N (was M)" whenever a *kept* step's position shifted,
making a reposition visible even for a step whose content never changed. Requesting
step numbers and fixing insertion position turned out to be the same underlying gap
(real position tracking, missing before this), not two unrelated asks.

**Verified for real, at every layer the fix touches.** Unit tests cover `applyStepDelta`'s
`order` handling (placement via a null placeholder, reordering alone, an unknown key
skipped, a step `order` omitted still surviving, interaction with `removedKeys`) and
`diffProposedSteps`'s new position fields. A new e2e test drives the mock's
`__mock_insert_middle__` branch. Then, because this was specifically reported as
visible end-to-end UI behavior, a real-browser script reran the actual scenario against
a genuine 3-step case: the diff's own labels placed the new step at "Step 2" (not 4)
with "Step 3 (was 2)"/"Step 4 (was 3)" for the displaced steps; Accept showed the real
editor table with the new step genuinely in place; Save and a re-fetch confirmed the
database persisted that exact order - checked at the diff preview, the live editor, and
the persisted database independently. `bun run typecheck` clean, full Docker rebuild,
all 84 e2e tests pass (83 prior + 1 new), all 31 unit tests pass (22 prior + 9 new).

## Spira import: reusing a legacy id as this system's own id (backlog item 9.16)

A team migrating from Spira often already has a custom field holding a pre-migration id
(e.g. "SYS-104") and wants an imported item to keep that number here rather than restart
from 1. Added as an optional "Legacy ID" mapping (same mechanism as every other optional
field mapping) on both the requirement and test case import screens.

**Design, and why it changed once already**: the first version gave `createRequirement`/
`createTestCase` an explicit `requestedSequenceNumber` param that tried to claim a number
and fell back to auto-assignment on collision (a per-row `SELECT`-then-decide check,
plus a `requestedSequenceNumberUsed` flag threaded back through both create functions and
their import wrappers). Working, but more machinery than the problem needed. Replaced
with a simpler design: **process rows in ascending order of their legacy number, bumping
the shared counter to just below each one before creating it normally.** Processed in
that order, from an empty starting point, every row's target slot is free *by
construction* - no per-row existence check, no fallback path, and no new parameter on
`createRequirement`/`createTestCase` at all; they're called completely unmodified.

- **`packages/integrations/spira/src/legacy-id.ts`'s `parseLegacySequenceNumber`** pulls
  the trailing run of digits out of the mapped field's value - handles a bare "104" or a
  prefixed "SYS-104"/"REQ_104" the same way, taking the *last* digit run so a
  year-prefixed value like "2024-104" still yields 104. A documented heuristic, not a
  general parser: a scheme that puts the number first (e.g. "104-A") would misparse.
- **`runSpiraImport`/`runSpiraTestCaseImport` switch to an "ordered" mode** whenever
  `mapping.legacyId` is set (`runOrderedSpiraImport`/`runOrderedSpiraTestCaseImport` in
  packages/integrations/spira): fetch every row up front (ignoring `startRow` - a sorted
  run can't usefully resume without refetching everything to re-sort anyway, and
  re-running from scratch is safe regardless since rows are still matched/deduplicated by
  Spira id the normal way), sort by the parsed legacy number ascending (unparseable ones
  last, keeping their relative order), then for each row in that single pass: bump the
  counter to `legacyNumber - 1` via a new `ensureSequenceCounterAtLeast`
  (packages/core/src/level-sequences.ts, a `greatest()` upsert - a no-op if the counter's
  already higher), then call the completely ordinary
  `createOrUpdateRequirementFromImport`/`createOrUpdateTestCaseFromImport`, whose own
  unmodified `nextSequenceNumber` call lands exactly on the legacy number as a result.
  Outside this ordered mode (no `legacyId` mapped), the original per-page streaming
  behavior - including `startRow` resumption - is completely unchanged.
- **Works fine into a level that already has items in it** (backlog item 9.20 - originally
  refused to run at all in that case, via a `productLevelHasRequirements`/
  `productLevelHasTestCases` precondition since removed as unused). That original
  restriction made the mode useless for its most natural use case: re-running an import,
  or running it alongside items created directly in this system. It turned out unnecessary
  - the existing per-row mechanism already does the right thing without it: a row already
  imported before (matched by Spira id via `external_links`, same idempotency check every
  import uses) is **updated** in place, its own sequence number never touched regardless
  of what its legacy id would resolve to today; a genuinely new row claims its requested
  number when free; and a requested number that's already taken - by another row in this
  batch, an earlier import, or something created directly here - doesn't fail the row,
  it's simply added with the next available number instead ("duplicate IDs ignored," now
  stated in both the per-row result and the mapping screen's own help text). One honest
  limitation, documented rather than hidden: a requested number at or below wherever the
  counter already sits (because something occupies that range) always rolls forward -
  there's no attempt to backfill a gap below the counter.
- **Verified with `scripts/verify-legacy-id-import.ts`**, not the e2e suite: that suite is
  a deliberate black-box HTTP contract test against the running app, and this mechanism
  only exists inside the Spira import path, which needs a real or mocked Spira server to
  exercise end to end (no Spira e2e coverage exists in this project yet). What's testable
  without one is the exact `ensureSequenceCounterAtLeast` + ordinary
  `createRequirement`/`createTestCase`/`createOrUpdateRequirementFromImport` composition
  the import functions use - see the script's own docstring, and
  `scripts/verify-audit-immutability.ts` for the precedent (another internal-only
  guarantee verified the same way). Run for real against the live dev database: legacy
  numbers given out of order land exactly on their own numbers once sorted and created; a
  duplicate legacy id within a batch, *and* one colliding with an item that already
  existed in the level before the run, both roll forward instead of colliding; re-
  importing the same Spira id updates the existing row in place with its sequence number
  unchanged rather than creating a duplicate; direct SQL checks confirm zero duplicate
  `(product_id, level_id, sequence_number)` pairs throughout - for both requirements and
  test cases. `bun run typecheck` clean, full Docker rebuild clean, all 40 e2e tests pass.

## Rich-text toolbar selection bug, and a Spira-style version diff (backlog item 9.8)

- **"I select bold by mistake" turned out to be two separate bugs**, not one:
  1. The toolbar's `<button>`s had no `onMouseDown={(e) => e.preventDefault()}` guard - a
     textbook Tiptap/ProseMirror gotcha. A plain button's `mousedown` fires before its
     `click`, and taking focus away from the `contenteditable` editor at that point changes
     or collapses the browser's selection *before* the click handler runs `toggleBold()` -
     so the command doesn't act on the selection the user actually made. Fixed by adding
     the guard to `ToolbarButton` (`rich-text-editor.tsx`) - the standard, documented fix.
  2. **The actual "still bold by default" symptom reported after that first fix was a
     second, unrelated bug**: shadcn's `Label` component ships `font-medium` in its own
     base classes, and four call sites (`requirements/[id]`, `requirements-section.tsx`,
     `test-cases/new/page.tsx` ×2) wrap a whole `<RichTextEditor>` *inside* a `<Label>` as
     a stacking layout (label text above the editor) - not `Label`'s intended one-line
     "text next to a single control" use. `font-weight` inherits by default, so every
     typed character silently rendered at medium weight with no `<strong>` mark involved
     at all - not a toggle-state bug, a pure CSS-inheritance one, invisible until someone
     actually looked at the rendered weight rather than the formatting state. Fixed at the
     source of fragility rather than patching four call sites: both `RichTextEditor` and
     `RichTextView` now explicitly set `font-normal` on their own root element, so neither
     is fragile to an ancestor's incidental font-weight class regardless of where either
     gets placed in the future.
- **Version history gained a Spira-style redline diff**: `requirements.get` already
  returned every version's full content (title/description/background) for the version
  history list - no backend change needed, purely a new UI component,
  `apps/web/src/components/version-diff.tsx`, using the `diff` package (`diffWords`, MIT,
  zero dependencies of its own) rather than hand-rolling a word-diff algorithm. Each version
  row gets a "Show changes" toggle revealing an inline redline against the *previous*
  version (added text underlined green, removed text struck through red) for title,
  description, and background. Background is rich HTML - diffed against a plain-text
  approximation (markup stripped) rather than the raw HTML, which would just be tag noise;
  this is explicitly a diff aid, not a faithful re-render of the rich content. The oldest
  version has nothing to compare against and says so rather than showing an empty diff.
  Test cases don't have this - they aren't versioned the way requirements are (no approval
  workflow, see the test-cases backlog item), so there's no history to diff.
- **Verified with real data, not just reasoning about the algorithm**: created a requirement,
  edited it through the real `editDraft` mutation to produce a genuine second version, then
  ran the exact same `diffWords` call the component uses against the two real API
  responses directly (not the component in a browser) - confirmed it correctly isolates
  "5" → "3" and detects the appended clause, rather than just diffing to noise. The detail
  page was also hit directly with a real two-version requirement and returned a clean 200
  with no error markers.

## Rich-text editor swap: shadcn-minimal-tiptap (backlog item 9.9)

- **Why swap instead of patching further**: the 9.8 fixes (toolbar `onMouseDown` guard,
  `font-normal` reset) were both real, correct fixes for real bugs, but the user reported
  bolding was still happening after both landed - meaning neither was the actual root
  cause. Rather than keep guessing at symptoms in a hand-rolled Tiptap wrapper, replaced it
  wholesale with the community `shadcn-minimal-tiptap` registry component
  (github.com/Aslam97/shadcn-minimal-tiptap, MIT). It ships `ResetMarksOnEnter` and
  `UnsetAllMarks` extensions purpose-built for Tiptap's actual mark-persistence bug class -
  "stored marks" (bold/italic/etc.) surviving a cursor move or newline and silently applying
  to the next thing typed, independent of any toolbar or CSS issue - the most likely true
  cause of what the user kept seeing.
- **Tiptap v2→v3 upgrade required**: the registry component targets Tiptap 3.x; all
  `@tiptap/*` packages were bumped to `3.31.3`. A `bun add` in place left a stale duplicate
  `@tiptap/core@2.27.3` in the store, causing a large cascade of `Editor` type
  incompatibilities - resolved only by a full clean reinstall (`rm -rf node_modules
  apps/web/node_modules bun.lock && bun install` from the repo root).
- **`RichTextEditor`'s external API is unchanged** (`value`/`onChange`/`placeholder`/
  `stepExecutionId`), so none of its call sites needed edits - it's now a thin wrapper
  around the vendored `MinimalTiptapEditor`.
- **Trimmed to match `sanitizeRichText`'s allowlist**, not the registry's full feature set:
  text color, headings 4-6, horizontal rules, and markdown paste were all dropped entirely
  (extensions removed, toolbar sections removed) because they produce markup - `style`
  attributes, `<span>`, `<hr>`, h4-h6 - that the sanitizer already strips on save. Offering
  them in the toolbar would let content look right while editing and then silently vanish
  once saved. Tables are now unconditionally available (previously gated behind a
  markdown-output mode this app never uses).
- **Vendored-file compatibility work**: this app's shadcn init is Base UI, not Radix (see
  the component-library section above), and several registry files assumed Radix APIs
  (`TooltipContentProps` types, a `tooltipOptions.onPointerDownOutside` prop that only
  exists on Radix's `TooltipContent`) - fixed by deriving types from this app's own
  components instead. Others just needed small fixes for this app's stricter
  `noUncheckedIndexedAccess` tsconfig setting, or a required-vs-optional option mismatch
  against the installed extension version (`exitOnArrowUp` on `CodeBlockLowlight`).
  `section/three.tsx` (a color picker) and the `markdown-paste`/`color` extension
  directories were deleted outright rather than patched, once nothing imported them -
  genuinely dead code once the sanitizer-incompatible features above were dropped.
  Confirmed along the way that a tsconfig `exclude` entry does **not** suppress errors for
  files still reachable through `include: ["src"]`'s glob matching (every matched file is
  typechecked as an independent root regardless of the import graph) - abandoned that
  approach for outright deletion.
- **A wrong hardcoded CSS import path broke the Docker build**: the vendored
  `styles/index.css` had `@reference "../../../global.css"` (three levels up, wrong
  filename) baked in from the registry's own directory layout assumptions. This app's real
  global stylesheet is four levels up at `src/app/globals.css`; fixed the path directly in
  the vendored file with a comment explaining why it differs from upstream.
- **Shipped too large on the first pass**: after all of the above landed and verified clean,
  the user's next report was "this new editor is absolutely unusable, and the top bar is
  ginormous... the old one had smaller footprint and looked so much better." Two distinct
  problems, not one:
  1. The upstream toolbar is genuinely sized like a full document-editor ribbon (48px bar,
     default-size 32px buttons, 20px icons, 8px separator margins) - reasonable for a
     single big editor per page, wrong for this app's shape (a requirement's background
     plus several step description/expected-result fields, each getting its own toolbar).
     Fixed by threading `size="sm"` through every toolbar section and shrinking icons to
     16px, bringing the bar down to 36px - matching the old homebrew toolbar's footprint.
  2. A real functional bug, not just an oversized one: the heading-style and "more actions"
     dropdown menus were styled `className="w-full"` in the upstream component. Both render
     through a portal with fixed positioning (Base UI's `Menu.Popup`), so `w-full` resolved
     against the *viewport* rather than the small toolbar button anchoring the menu -
     opening the heading picker produced a dropdown spanning the entire page width. That
     alone plausibly explains "unusable" on its own. Fixed by giving both menus an explicit
     fixed width (`w-56` for the heading menu, `w-48` for the overflow menu) instead of
     `w-full`.
- **Verified with real data and a real build, twice** (before and after the size fix): full
  clean Docker rebuild, all 29 e2e tests passing, and - the check that actually exercises
  the sanitizer, not just the build - a requirement created through the live
  `requirements.create` API with a `background` payload mixing allowed markup
  (bold/italic/strikethrough/links/lists/a table) with markup that should be stripped
  (`<span style>`, `<hr>`, `<h4>`, a `<script>` tag): a live re-fetch confirmed the allowed
  formatting survived untouched and the disallowed markup was stripped or removed exactly
  as `sanitizeRichText` is supposed to. After the size/width fix, the running container's
  shipped JS bundle was grepped directly to confirm the smaller `h-9` toolbar class made it
  into the build and the old `h-12` one didn't. What's still unverified here (no browser
  available in this environment): actually clicking into the toolbar to confirm the
  footprint and dropdown width read right, and that bold no longer persists across a cursor
  move - worth the user's own once-over.
- **Follow-up: the editable area itself had no reserved space.** Even at the corrected
  toolbar size, the vendored ProseMirror element has no padding or min-height of its own -
  it sizes purely to its content, so an empty or short field showed almost no visible
  writing room under the toolbar. `MinimalTiptapEditor` already accepts an `editorClassName`
  prop for exactly this (distinct from `editorContentClassName`, which targets the wrapper
  div around the editable element, not the contentEditable element itself) - this app just
  wasn't passing it. Fixed in `RichTextEditor` with `editorClassName="min-h-40 p-3"`.

## Tabular requirement and test-case lists, with IDs shown (backlog item 9.10)

- **The gap**: the product page's requirement and test-case lists (`requirements-section.tsx`,
  `test-cases-section.tsx`) were `<ul>`/divided-list rows carrying only a title plus a couple
  of secondary fields - no visible identifier at all. For a traceability tool built around
  IEC 62304 concepts, being unable to see which requirement/test case an entry actually *is*
  (only its title) is a real functional gap, not a style nitpick - the user asked for it back
  explicitly ("IDs are important to show").
- **No separate human-readable sequence number exists in the schema** (no "REQ-1" style
  field) - only the real database UUID (`requirements.id`/`testCases.id`). Rather than invent
  a display-only numbering scheme not backed by anything real, both lists now show the first
  8 characters of the actual id, monospace, muted, with the full UUID available as a native
  tooltip (`title` attribute) - an honest, truncated view of the real identifier rather than
  a synthetic one.
- **Converted both lists from `<ul>` rows to real `<table>`s** (added shadcn's `table`
  component - a plain styled wrapper over native `<table>`/`<thead>`/`<tbody>`/`<tr>` etc.,
  no Radix/Base UI dependency, unlike most of this app's other shadcn primitives) so more
  columns fit legibly instead of cramming everything into a title line's secondary text:
  - Requirements: ID · Title (the link) · Safety class · Version · Status · Traces to.
  - Test cases: ID · Title (the link) · Type · Created.
  Only the title cell is a link (each row itself isn't, to avoid the accessibility/markup
  cost of faking a clickable `<tr>`) - the same "click the name" convention used by most
  real-world tabular lists (e.g. GitHub's issue tables).
- **Verified with real data through the actual queries the table consumes, not just
  reasoning about the JSX**: rebuilt clean, all 29 e2e tests still pass, both artifact pages
  return clean 200s with real ids in the URL. Both lists are client components (`"use
  client"` + a tRPC query, not server-rendered HTML), so a raw curl of the page can't show
  the actual rendered table the way earlier server-rendered-field checks could - instead,
  created a real requirement (with a safety classification) and a real test case through the
  live `create` mutations, then called `requirements.listByProduct`/`testCases.listByProduct`
  directly and confirmed every field the new columns render (`id`, `title`,
  `safetyClassification`, `versionNumber`, `statusName`, `parentTitle` for requirements;
  `id`, `title`, `testType`, `createdAt` for test cases) is present and correctly populated.
  Actually seeing the rendered table is still something only the user can confirm from here.

## Rich-text editor: a real focus/typing bug, caught with a real headless browser (backlog item 9.11)

- **Why this needed an actual browser, not more reasoning**: the 9.9 work verified a clean
  build and the generic e2e suite, neither of which exercises focus or typing at all - so a
  real bug shipped. When the user reported "I can't type, focus goes to the toolbar," this
  session set up `puppeteer-core` (already-installed system Chrome, driven headlessly - no
  browser download needed) to register a user, open a real form, and literally click into
  and type in the field. This is the only way this class of bug is actually observable from
  this environment, and it's now the standard to reach for whenever a report is about
  interaction (focus, clicks, keyboard) rather than content or layout.
- **Bug 1: nested `<button>` elements**, found via a captured `outerHTML` showing
  `<button data-slot="tooltip-trigger"><button data-slot="toggle">...`. `ToolbarButton`'s
  own Tooltip wrapped its Toggle via `<TooltipTrigger>{toggleButton}</TooltipTrigger>` -
  the registry's original Radix-`asChild`-style composition. This app's Base UI
  `TooltipTrigger`, given plain children instead of `render`, renders its own `<button>` and
  nests the child inside it - invalid HTML. Fixed with `render={toggleButton}`, the same
  polymorphism convention already used correctly elsewhere in this vendored tree (e.g.
  `DropdownMenuTrigger render={<ToolbarButton .../>}` in `section/one.tsx`). The four
  call sites that wrap `ToolbarButton` itself in an *outer* Menu/Popover/Dialog trigger
  (heading menu, the two overflow menus, link, image) also had their own `tooltip=` prop
  removed, since double-stacking Tooltip *inside* another trigger's `render` chain turned
  out to be unreliable in its own right (aria-label alone still carries the accessible
  name for these five).
- **Bug 2: a stray focus/click event on the first toolbar element - real, reproducible,
  not fully root-caused.** Even after fixing the nesting, a headless click straight into a
  freshly-mounted, empty editor produces one extra focusin+click on whichever toolbar
  element is first in DOM order, firing immediately after the real click correctly lands on
  the editor. Confirmed via native `document.addEventListener(..., true)` capture-phase
  logging (so this is a real second browser-native event, not a misread of React's
  synthetic system) and confirmed to follow *whichever* component is first by temporarily
  removing and reordering toolbar sections - it isn't specific to the heading dropdown, a
  Tooltip, or any one component. A plain formatting toggle (Bold) absorbs this harmlessly -
  something (most likely Tiptap's own focus-sync effect) corrects focus back to the editor
  moments later, and typing works fine. A dropdown/popover/dialog trigger does not recover:
  Base UI's Menu/Popover/Dialog open on `mousedown`, and once open they deliberately hold
  focus inside themselves - correct behavior for a menu a user actually meant to open, but
  fatal when what opened it was this stray phantom event instead. Fixed pragmatically by
  reordering the toolbar so a plain toggle (Bold/Italic/Underline) always renders first,
  so the stray event always lands somewhere that recovers. The stray event's true origin is
  still not nailed down (suspected ProseMirror/React re-render interaction around the
  editor's first focus) - flagged in code for a follow-up if it resurfaces elsewhere in a
  different shape, since this is a workaround for the symptom's blast radius, not a fix for
  its cause.
- **Tab order**: sequential Tab now skips every toolbar element entirely and lands directly
  on the editable text, per the user's explicit request. `ToolbarButton` sets
  `tabIndex={-1}` by default on its own `Toggle` (an explicit tabIndex from a caller still
  wins - none currently pass one). That alone was enough for plain formatting toggles, but
  not for the five dropdown/popover/dialog triggers: Base UI's own trigger components
  re-assert their own `tabIndex` as part of their internal prop-merge, applied *after* and
  overriding whatever the rendered child element set - so those five needed
  `tabIndex={-1}` set explicitly on the outer `DropdownMenuTrigger`/`PopoverTrigger`/
  `DialogTrigger` itself to actually take effect. All toolbar buttons remain fully
  clickable by mouse; only their stop in the sequential Tab order is gone, trading away
  pure-keyboard reachability of the toolbar for the thing that actually matters here -
  landing in the text immediately.
- **Verified with the same real headless browser, before and after each fix** - not
  re-reading the diff and assuming it worked: a real `elementHandle.click()` on
  `.ProseMirror` followed by checking `document.activeElement`, and real
  `page.keyboard.type("Hello world")` calls confirmed to actually land in the document's
  text content; a real `page.keyboard.press("Tab")` loop from the field above the editor
  confirmed it now reaches the editable text in exactly one step. Also reran the full
  Docker build and all 29 e2e tests after every change in this sequence.

## Clear list links, and requirements opening straight into edit mode (backlog item 9.12)

- **Link styling wasn't actually link-styled.** The product page's requirement/test-case
  table rows (backlog item 9.10) had the Title cell using default text color with a
  hover-only color change and no underline - technically a link, but unreadable as one at
  rest. Restyled both to the app's existing link convention (already used for
  parent/child/step traces on the detail pages): `text-primary`, underline on hover. The
  requirements table's "Traces to" cell was plain, non-linked text because
  `requirements.listByProduct` never selected `parentRequirementId` (only the parent's
  title, via a join) - added the missing column and made the cell a real
  `Link` to the parent. Test-case step-level "Traces to" was a single comma-joined string
  with no links at all; each requirement title in it is now its own link.
- **Requirements now open directly into edit mode**, replacing the previous default
  read-only landing that required an extra "Edit (new version)" click before you could
  change anything. Gated on the current version's status: only `draft` versions - the ones
  actually eligible for further edits under the existing approval workflow - auto-open into
  the edit form (title/description/background fields pre-populated exactly as `startEditing`
  already did on click); anything locked past draft (in_review/approved/baselined) still
  opens read-only, now with an explicit note explaining *why* ("this version is approved and
  locked for editing - see the available transitions below") instead of a silently-absent
  Edit button. Implemented as a `useEffect` guarded by a `useRef` flag rather than derived
  directly from the query result, specifically so it fires exactly once per page visit -
  deriving it from `detail.data` directly would re-force the page back into edit mode (and
  stomp on in-progress typing) every time the query refetches, which happens right after
  every save.
- **Test cases were left out of the edit-mode change on purpose, not by oversight**: there
  is no test-case update/edit capability anywhere in this app yet.
  `packages/core/src/test-cases.ts` has no generic update function - only
  `createOrUpdateTestCaseFromImport`, which upserts by external link for the Spira importer
  specifically - and the tRPC router has no corresponding mutation. "Open in edit mode" only
  makes sense once real test-case editing (title, test type, step add/remove/reorder,
  requirement links) exists; that's a genuinely separate, larger feature, not something to
  half-build here just to have *something* open in an edit-shaped box.
- **Verified**: rebuilt clean, all 29 e2e tests pass. Hit `requirements.listByProduct`
  directly for a real parent/child pair created through the live `create` mutation and
  confirmed `parentRequirementId` is now present (it was always `null`/absent before).
  Used the same real-headless-Chrome technique as 9.11 (not just re-reading the diff) to
  confirm actual page behavior: a freshly created draft requirement's page loads with the
  title/description fields already filled in and the "Save new version" button present -
  genuinely in edit mode, no click needed - while the same requirement, moved to `approved`
  through a real `transition` mutation, loads read-only with the locked-explanation text
  present and no edit control.

## Test case editing, and a shared tabular step editor (backlog item 9.13)

- **`updateTestCase` (packages/core/src/test-cases.ts)** is a full-replace update: title,
  test type, case-level requirement links, and the complete step list in one call. The step
  list is always the *whole* desired list in its new order - `stepNumber` is derived purely
  from array position, so reordering is just resubmitting the list differently, not a
  separate operation. Steps carry an optional `id`: present means "edit this step in place,"
  absent means "insert a new one." Diffing incoming vs. existing step ids by set difference
  finds removed steps.
- **The one real constraint on deleting a step**: `test_step_executions.test_step_id`
  references `test_steps` with no `onDelete` cascade and is `NOT NULL` - by design,
  historical execution evidence must stay resolvable to the step it ran, so Postgres will
  outright refuse to delete a `test_steps` row that any execution still references. Rather
  than let that surface as a raw foreign-key-violation error, `updateTestCase` checks
  `test_step_executions` for the steps about to be removed *before* touching anything, and
  throws a clear `DomainError` instead. Editing an executed step's own text is still allowed
  - steps were never versioned in this app to begin with (only an execution's snapshot at
  run time is frozen - see the test-cases section above), so there's no new inconsistency
  introduced by allowing that. This check runs inside `withTenant`'s existing
  `db.transaction`, so a refused deletion can't leave anything else in the same submission
  half-applied.
- **`testCases.get` now also returns `directRequirementIds`** - the case-level requirement
  links only, distinct from `effectiveRequirementLinks` (the union with everything reachable
  via a step link, already existed for display). An edit form needs the direct-only list to
  correctly pre-populate its case-level picker; pre-populating it with the union instead
  would silently promote every step-derived link into an explicit direct one on save.
- **A shared, tabular step editor** (`apps/web/src/components/test-steps-editor.tsx`) used
  by both the "new test case" page and the test-case detail page's edit form - previously
  each step was its own `Card` stacking three full-size rich-text fields (description,
  expected result, purpose) plus a full-width multi-select, repeated per step: exactly the
  "don't waste space" complaint. Now one row per step in a real `<table>`:
  - Description and expected result are edited directly in their cells via a new `compact`
    prop on `RichTextEditor` (shorter `min-h-16` instead of the default `min-h-40` - a step
    is a line or two, not a document that needs the same reserved reading room as a
    requirement's background field).
  - Requirement links collapse into a small `Popover` (checkboxes, not the full-width
    native multi-select used elsewhere) so the row stays scannable; clicking it shows a
    link-count badge rather than an always-open listbox eating vertical space.
  - Purpose - present but rarely used - is collapsed behind a "+ Add purpose" toggle per
    row instead of always reserving a third editor's worth of height; it opens automatically
    if the step already has one.
  - Reordering is up/down icon buttons, not drag-and-drop: this app has no DnD library, and
    arrow buttons are simpler to get right and fully keyboard-reachable without adding one.
    Delete is a trash icon, disabled once only one step remains (`updateTestCase`, like
    `createTestCase`, refuses an empty step list).
  - Note for anyone touching `Popover`/`DropdownMenu`/etc. triggers in this codebase: use
    `render={<Button .../>}`, never `<PopoverTrigger><Button/></PopoverTrigger>` - the
    latter reintroduces the exact nested-`<button>` bug found and fixed in the rich-text
    toolbar (backlog item 9.11). `PopoverTrigger` here follows the same convention.
- **The test-case detail page now always opens in edit mode** - not behind a separate
  read-only landing the way the requirements page is. Test cases have no locked/approval
  workflow at all (see the "Test cases, steps, execution, and evidence" section above), so
  there's no "unless locked" condition to gate on the way 9.12 added for requirements: the
  page simply *is* the edit form. "Discard changes" resets local state back to the last
  fetched server values (via the same one-shot-`useEffect` + `useRef` initialization pattern
  used for the requirements page, so refetches after a save don't clobber in-progress
  edits); "Save changes" persists through `testCases.update` and re-syncs local state from
  the mutation's own response, paired by array position with the just-submitted variables
  (the response doesn't echo requirement links back, and a brand-new step's real id isn't
  known until the response arrives).
- **Verified against the real API and a real build, not just the diff**: `bun run
  typecheck` clean across every package, full Docker rebuild clean, all 29 e2e tests still
  pass. Exercised `testCases.update` directly: reordered two existing steps, edited one's
  text, and added a brand-new step in a single call, then confirmed via `testCases.get`
  that stepNumber/content/order all came back correctly; started a real execution against
  one step, then confirmed removing that specific step through `update` is refused with the
  expected message while removing a never-executed step in the same test case succeeds;
  confirmed step-level and case-level requirement links round-trip correctly and
  `directRequirementIds`/`effectiveRequirementLinks` stay distinct as designed. The
  test-case detail page returns a clean 200 with real data end-to-end.

## Step editor redesign: read by default, one row editable at a time (backlog item 9.14)

- **What was wrong with the first version**: every step row mounted two live
  `RichTextEditor` instances (description, expected result) plus a third for purpose - full
  toolbars included - unconditionally, all the time, for every step. Fine for one step, a
  wall of toolbars for a ten-step test case. The user's report named four distinct problems
  in one message, all real: "looks like poop," "loads gazillion rich text editors at once,"
  "should be OK to click a little edit icon," "make sure all fields fit."
- **Read by default, edit on click**: `TestStepsEditor` now tracks which step keys are
  "open for editing" in a `Set<string>` (`editingKeys`), empty by default. A step not in
  that set renders its description/expected result via `RichTextView` (the existing
  lightweight, no-toolbar, no-editor-engine renderer used everywhere text is displayed
  read-only) instead of mounting a `RichTextEditor`. Clicking a row's pencil icon
  (`aria-label="Edit step"`) adds that step's key to the set, swapping just that row's two
  fields over to real editors; the icon becomes a checkmark to close back to read mode. A
  brand-new step (added via "Add step") is inserted with its key already in `editingKeys` -
  there's nothing to show in read mode for an empty step, so it should open straight into
  editing.
- **Purpose is now genuinely plain text, not a third rich-text editor**: per the user's
  explicit instruction ("purpose doesn't have to be rich text, just description and
  expected result"), it's a plain `Textarea` in the row - no toolbar. On the backend,
  `createTestCase`/`updateTestCase` in `packages/core/src/test-cases.ts` no longer run
  `purpose` through `sanitizeRichText` - just `.trim()` - since it's rendered via plain JSX
  text interpolation (React-escaped, safe by construction) rather than
  `dangerouslySetInnerHTML`, so an HTML-sanitizer pass buys nothing for it. This is a
  behavior change only, not a schema one - `test_steps.purpose` was already a plain `text`
  column. The Spira importer's `createOrUpdateTestCaseFromImport` path was deliberately left
  as-is (still calls `sanitizeRichText` on incoming purpose text) - out of scope here, and
  changing an existing, working import path without a way to verify it against real Spira
  data felt like the wrong tradeoff. To keep both paths displaying correctly under the new
  plain-text rendering, a small `purposeAsPlainText` helper in `test-steps-editor.tsx`
  strips any leftover HTML down to plain text at display time (converting `<br>`/block-end
  tags to newlines first) - handles both genuinely-plain purpose values (passes through
  unchanged) and any legacy/imported HTML-ish ones.
- **"Make sure all the fields fit" was a real CSS bug**: the table used the browser default
  `table-layout: auto`, under which columns size to their content's *intrinsic* width - and
  the rich-text toolbar's own inner row (`flex w-max`) has an intrinsic width that can
  exceed its column's fair share, forcing the whole table wider than its container and
  requiring horizontal scrolling to see every field. Fixed with `table-fixed` on the
  `<Table>` (a plain Tailwind utility, no component change needed - `Table`'s `className`
  merges through), which makes column widths respect the table's own distribution; an
  overflowing toolbar now scrolls *within* its own cell (it already carries its own
  `overflow-x-auto`) instead of blowing out the layout.
- **Verified with a real headless browser, not just re-reading the diff**: created a real
  two-step test case through the live API and loaded its detail page - confirmed exactly
  zero `.ProseMirror` editors mounted on initial load (both steps showing as plain rendered
  text, no toolbars anywhere), then clicked one step's edit icon and confirmed exactly two
  editors mount - that row's own two fields, not the whole table. Confirmed `table-fixed`
  is present on the actual rendered table, and the table wrapper's `scrollWidth` vs.
  `clientWidth` differ by only a few pixels (no meaningful horizontal overflow left).
  Separately confirmed via the live `testCases.create` API that a purpose value containing
  literal `<`, `&`, and `>` characters round-trips through storage completely unchanged -
  no sanitizer mangling now that it's genuinely plain text, not parsed as HTML at all.
  `bun run typecheck` clean across every package, full Docker rebuild clean, all 29 e2e
  tests pass.
- **Follow-up: that verification only checked the table in read mode** - not the one state
  that actually still had a problem. `max-w-0`/`overflow-hidden` correctly stopped the
  table from ever overflowing the *page*, but with each text column only ~340px wide, the
  compact toolbar (needs ~410px to lay out its sections in one row) no longer overflowed
  the page - it now overflowed *itself*: real, measured internal scrolling that hid some
  of its own buttons. Confirmed directly by measuring the toolbar element's own
  `scrollWidth` vs. `clientWidth` in a real headless browser before the fix (417px vs.
  301px - genuine overflow, not a guess) and after (620px vs. 620px - none). Fixed by
  giving an *editing* row's Description and Expected result one combined, full-width table
  cell (`colSpan={2}`, stacked vertically) instead of squeezing two separate rich-text
  editors into two narrow side-by-side columns; the read-mode (default) layout keeps them
  side by side, since plain rendered text via `RichTextView` never had this problem in the
  first place. Also checked a 420px (phone-width) viewport and found a real ~40px
  body-level horizontal overflow there too - but confirmed via the same technique that it
  reproduces identically on the plain product page with no step table anywhere near it, so
  it's pre-existing and unrelated to this component; left alone rather than folded in here.
  The lesson for next time: verify a component in *every* interactive state it can be in,
  not just its default one - "it renders" and "it works once you actually use it" are
  different claims.
- **`overflow-wrap: break-word` (plus the legacy `word-wrap: break-word` alias)** - the
  same fix Spira itself uses, per the user, for exactly this class of problem: a long
  unbroken string (a URL, an id, anything with no spaces) in rendered content overflowing
  its container instead of wrapping. This is a *different* failure mode from the
  toolbar-layout fix above - that one was about a row of buttons' intrinsic width, this one
  is about text content with no natural break points - and `overflow-hidden` alone (used
  above) clips such content rather than wrapping it, so both were needed. Added in three
  places: `.rte-content` (globals.css, the read-only rich-text renderer - benefits every
  place rich text is displayed read-only, not just test steps); the vendored editor's own
  `.minimal-tiptap-editor .ProseMirror` rule (so the same content doesn't overflow while
  actively being edited, matching the read-only renderer); and defensively on the shared
  `TableCell` component (`components/ui/table.tsx`) - a no-op for the `whitespace-nowrap`
  cells used for short fields (IDs, dates), but wraps long content in any cell overriding
  that to `whitespace-normal` (the title/traces-to columns added in 9.12). Verified with a
  real 120-character unbroken string submitted as a step's description through the live
  API: no overflow at the table, `<main>`, or `<body>` level, measured the same way as the
  toolbar-layout fix above (not just visually eyeballed).
- **The actual bug, per the user's own correction: "it's the normal cell... what overflows
  is hidden."** They were right, and the two fixes above were addressing real but adjacent
  problems while this one stayed live underneath. Root cause: `TableCell` defaults to
  `whitespace-nowrap`, `white-space` is an inherited CSS property, and `TestStepsEditor`'s
  cells never overrode it back to `whitespace-normal` - so every paragraph rendered inside
  them via `RichTextView` inherited `nowrap` and was forced onto one line no matter how
  long the content was. Stacked with `overflow-hidden` (added for the toolbar-layout fix),
  anything past the first line's width was silently clipped - precisely "doesn't fit the
  column and what overflows is hidden." This also explains why the `overflow-wrap` fix
  didn't help: that property only refines *where* a line breaks once the browser is already
  trying to wrap at all, and `white-space: nowrap` prevents wrapping outright, so there was
  never a wrap attempt for it to act on. Fixed with `whitespace-normal` on all three of
  `TestStepsEditor`'s `TableCell`s (both read-mode preview cells and the edit-mode `colSpan`
  cell). Verified with realistic multi-word prose - a full sentence-length step description,
  not the earlier single long word, which is exactly why that verification missed this: a
  single word is unaffected by `white-space: nowrap` vs. `normal` either way, so it never
  exercised the actual bug. The real check: the paragraph's rendered height came back
  ~126px (several wrapped lines) instead of a clipped single line's ~20px, `getComputedStyle`
  confirmed `white-space: normal` where it previously resolved to the inherited `nowrap`,
  and the full submitted text (start through end) is present in the cell rather than cut off
  mid-sentence.

## Traceability matrix, and "covered by"/"covers" visibility (backlog item 6)

- **`getTraceabilityMatrix`** (`packages/core/src/traceability.ts`) computes one row per
  (requirement, covering test case) pair for a product, each augmented with that test
  case's most recent execution. A requirement with no covering test case still gets a row
  with the test/execution columns null - a coverage gap needs to be visible, not just
  absent from the output. Deliberately built as a few simple queries joined in application
  code (not one large SQL join with a LATERAL "most recent execution" and a UNION of the
  two link paths) - easier to verify by reading, and fine at the scale a single product's
  data reaches. `getCoveringTestCases` (`packages/core/src/test-cases.ts`) is the same
  direct-links-union-step-links computation at a single-requirement scale, used by the
  requirement detail page - the exact inverse of the existing `getEffectiveRequirementLinks`.
- **New `?artifact=traceability` tab** alongside Requirements/Test Cases on the product
  page (`traceability-section.tsx`, a new `traceabilityRouter`), rendered as a real
  `<table>` on purpose - pasting an HTML table straight into a spreadsheet preserves rows
  and columns natively, which is what "easy to export to Excel" actually calls for before
  reaching for a file format. A client-side "Export CSV" button covers the rest (a very
  long matrix, or wanting an actual file) - built by hand (a `Blob` + a temporary
  `<a download>`), no library needed for something this small.
- **List/detail visibility**: `requirements.listByProduct`/`testCases.listByProduct` each
  gained a lightweight count column (`coveredByCount`/`coversCount`) - a quick-glance
  signal, not the full linked-item list (that's what the detail pages and the matrix are
  for). `requirements.get` now also returns `coveringTestCases`, rendered as a new
  "Covered by" line on the requirement detail page - test case detail already had the
  equivalent ("Traces to", via the existing `effectiveRequirementLinks`).
- **Verified against the real API/DB**: a requirement covered by a direct case-level link,
  one covered only via a step link, and one genuinely uncovered all resolve to the correct
  matrix rows (including the step-linked one correctly picking up the same test case and
  execution as the direct one); a real completed execution's `pass` status surfaces as that
  test case's "last execution" everywhere it's shown. `bun run typecheck` clean across
  every package, full Docker rebuild clean, all 29 e2e tests pass.

## Sequential per-level human-readable ids (backlog item 9.12)

- **Storage model**: `requirement_levels.code`/`test_levels.code` (a per-tenant-unique text
  column, e.g. "SYSREQ") plus `requirements.sequenceNumber`/`test_cases.sequenceNumber`
  (a plain integer). The displayed id (`SYSREQ-1`) is computed by joining the two at *read*
  time, not stored as one string - editing a level's code in Settings changes how
  everything under it displays from that point on, while the sequence numbers underneath
  are untouched. This was a deliberate choice, not an oversight: freezing the code into
  each item at creation time would mean a renamed level's old items keep showing a stale
  prefix forever, which defeats the point of making the code editable at all.
- **Atomic sequence assignment** (`packages/core/src/level-sequences.ts`'s
  `nextSequenceNumber`): one `insert into level_sequence_counters (...) values (...) on
  conflict (product_id, level_id) do update set last_number = last_number + 1 returning
  last_number` - not a read-then-write, so two concurrent creates against the same level
  can't both read "last was 4" and each try to save "5"; Postgres serializes the second
  behind the first's row lock. Called from inside the same transaction that creates the
  item it numbers (`createRequirement`/`createTestCase`, both already running inside
  `withTenant`'s `db.transaction`), so a failed creation rolls the counter back too instead
  of permanently burning a number on nothing.
- **Scoped per (product, level), not per tenant** - `level_sequence_counters`' primary key
  is `(product_id, level_id)`. A level definition (e.g. "System Requirement") is a
  tenant-wide row shared across every product, but its *numbering* restarts at 1 for each
  product independently, matching how every other requirement/test-case list is already
  scoped to one product at a time (and how tools like this conventionally number within a
  project, not globally).
- **Migration backfilled real, already-existing data** (`packages/db/migrations/
  0010_loving_spirit.sql`, hand-edited after `drizzle-kit generate` - it only knows how to
  add bare `NOT NULL` columns, which fails outright against any existing rows): columns
  added nullable first, then backfilled, then locked down - the same pattern used for the
  earlier fixed-enum-to-table migration. Codes: the three seeded requirement levels and the
  one seeded test level get their real, friendly names (`SYSREQ` for "System Requirement",
  matching the user's own example exactly); anything else gets a generic derived code
  (uppercase, alphanumeric only, first 12 characters), de-duplicated via a
  `row_number() OVER (PARTITION BY tenant_id, code ...)` window function for the rare case
  two differently-named levels reduce to the same string. Sequence numbers: backfilled via
  `row_number() OVER (PARTITION BY product_id, level_id ORDER BY created_at)`, i.e.
  existing items are numbered in the order they'd have gotten these ids in if the feature
  had existed from the start; the counters table is then seeded with `max(sequence_number)`
  per (product, level) so the very next real insert continues correctly instead of
  restarting at 1 and colliding with an id already on screen somewhere.
- **Run for real against this session's own accumulated dev data**, not a clean database -
  4700+ `requirement_levels` rows, 1600+ `test_levels`, 1577 `requirements`, 324
  `test_cases` across many tenants created over the course of this whole session's testing.
  Applied with zero errors. Checked directly afterward: zero duplicate `(tenant_id, code)`
  pairs, zero null sequence numbers, every (product, level)'s sequence numbers running
  cleanly from 1 to its row count with no gaps, and every counter's `last_number` exactly
  matching the real backfilled maximum - not just "the migration ran," but "the data it
  produced is actually correct."
- **A real bug found by the new e2e coverage, not caught by typecheck or a clean build**:
  the duplicate-level-code rejection path was silently broken. Investigated by deliberately
  triggering a real unique-constraint violation against the live database and inspecting
  the thrown error directly rather than guessing: Bun's native Postgres driver wraps the
  real error in a `DrizzleQueryError` (the actual driver error lives on `.cause`, not
  merged into the top-level error), and on that inner error it reports its own generic
  `code: "ERR_POSTGRES_SERVER_ERROR"` while the real Postgres SQLSTATE (`23505`) turns up
  in `.errno` instead - a different shape than a node-postgres-style driver, which would
  put it directly in `.code`. The original check (`"code" in err && err.code === "23505"`
  on the top-level error) matched neither location. Fixed with a bounded `.cause`-chain
  walk checking both `.code` and `.errno` at each level
  (`packages/core/src/level-sequences.ts`'s `isUniqueViolation`), shared by both
  `requirement-levels.ts` and `test-levels.ts`'s create/update-code paths (previously two
  near-duplicate, both-wrong copies).
- **Displayed everywhere a requirement or test case appears**: product-page list tables
  (replacing the earlier truncated-UUID "ID" column from backlog item 9.10), both detail
  page headers, parent/child requirement references, the requirement "Covered by" /
  test-case "Traces to" cross-references, step-level requirement links, every
  requirement-link picker (parent dropdown, case-level and step-level link pickers), and
  the traceability matrix (including its CSV export, as a dedicated "Requirement ID"/"Test
  Case ID" column pair). `apps/web/src/lib/format-item-id.ts`'s `formatItemId(code,
  sequenceNumber)` is the one shared formatter every call site uses, so the `CODE-N`
  format is consistent everywhere rather than each page inventing its own string
  interpolation.
- **Settings**: `OrderedListEditor` (shared by requirement levels, test levels, and
  environments) gained optional code-editing support - a separate input and a separate
  `onUpdateCode` callback from the existing rename flow, since a team might fix a typo in
  one without touching the other. Environments don't pass the code props at all, so the
  component's original name-only behavior is unchanged for them.
- **Verified**: `bun run typecheck` clean across every package, full Docker rebuild clean,
  all 32 e2e tests pass (29 existing + 3 new covering per-product independent numbering
  for both requirements and test cases, and the now-actually-fixed duplicate-code
  rejection). A real headless browser confirms the formatted id string renders on the
  requirement list, requirement detail, test case detail, traceability matrix, and
  settings pages.

### Follow-up: architecture review and hardening

A review of this feature before more code built on top of it (still early enough to
change the shape cheaply) led to several changes, applied together:

- **`requirement_levels` and `test_levels` merged into one `levels` table** with a `kind`
  ('requirement' | 'test', CHECK-constrained) column - see the table's docstring in
  packages/db/src/schema.ts and packages/core/src/levels.ts (the shared CRUD
  implementation; requirement-levels.ts/test-levels.ts are now thin kind-bound wrappers
  over it, so every existing call site keeps its original function name). Two real things
  this fixes: `level_sequence_counters.level_id` is now a genuine foreign key (it used to
  be a bare uuid pointing at whichever of the two tables happened to own the id, with
  nothing in the schema saying which), and a level's `code` is now unique across a
  tenant's *entire* id-prefix namespace rather than per-kind - a requirement level and a
  test level could previously pick the same code and produce an ambiguous id (a "TC-1"
  that could mean either). `(tenant_id, kind, name)` uniqueness (replacing the old
  per-table `(tenant_id, name)` constraints) preserves the "no two same-kind levels share
  a name" rule. Migration: `migrations/0011_merge_levels.sql` (drizzle-generated, trimmed
  to just the additive `CREATE TABLE levels` - see its header for why) plus
  `migrations-manual/009_levels_merge_constraints_and_rls.sql` (the data backfill
  preserving every row's original id, the CHECK/unique constraints, RLS, and the old-table
  drop + FK rewiring) - **run for real against this session's live dev database** (5671
  requirement_levels + 1955 test_levels rows across 1908 tenants), verified afterward with
  zero orphaned FK references anywhere and zero data loss.
- **A level's `code` is now immutable once any requirement/test case has been created
  under it** (`packages/core/src/levels.ts`'s `updateLevelCodeOfKind`) - previously
  editable indefinitely, which meant an id already printed on a signed approval, an
  exported traceability matrix, or a Jira/Spira cross-reference could silently start
  meaning something else. A still-empty level (the common case - fixing a typo right
  after creating it) stays freely renamable.
- **`requirement.created`/`test_case.created` audit log payloads now stamp the full
  formatted display id** (`displayId`, via the new `formatItemId` call at write time), not
  just the raw level name - so the hash-chained audit trail stays self-describing even
  after a later level-code rename, instead of silently reading as if today's code always
  applied.
- **A real independent database-level guarantee**: `unique (product_id, level_id,
  sequence_number)` added to both `requirements` and `test_cases` - the atomic counter in
  `nextSequenceNumber` is what makes a collision practically impossible, but nothing
  previously stopped a bug in the counter, a script, or a future write path that bypasses
  it from silently producing two items answering to the same human-readable id.
- **`level_sequence_counters`'s primary key grew `tenant_id`** (now `(tenant_id,
  product_id, level_id)`, was `(product_id, level_id)`) purely for consistency with every
  other tenant-scoped table's key convention in this schema - `product_id` already implied
  a tenant via its own FK, so this isn't a fix for an observed bug.
- **A branded `TenantTx` type** (`packages/db/src/client.ts`) replaces `AppDb` as the `db`
  parameter type on every packages/core domain function. Same runtime type as `AppDb` -
  the brand is compile-time only - but it turns "this function must be called from inside
  `withTenant`'s transaction" from a doc-comment convention into something the compiler
  checks: a call site that accidentally passes the raw connection pool (bypassing
  RLS/tenant scoping) now fails to typecheck instead of only surfacing later as a runtime
  RLS rejection.
- **The Spira importers (`runSpiraImport`/`runSpiraTestCaseImport`) now open one
  transaction per row instead of wrapping the entire (potentially thousands-of-rows) run
  in a single one.** The single-transaction version had two real problems: the sequence
  counter row for the target (product, level) - and, via the audit-log trigger's advisory
  lock, every audit-writing mutation in every tenant - stayed locked for the run's entire
  duration; and the per-row try/catch didn't actually isolate failures, since Postgres
  aborts an entire transaction after any failed statement within it, so one bad row made
  every subsequent row in the same run fail too with "current transaction is aborted"
  rather than its own real error. The router (`apps/web/src/server/routers/
  spira-import.ts`) now passes the raw connection pool instead of pre-opening a
  transaction; each importer opens its own `withTenant` per row.
- **`formatItemId`/`parseItemId` moved to `packages/core/src/item-id.ts`** (parseItemId is
  new - the inverse of formatItemId, for a future "paste an id" search) so non-web code
  (the traceability export, a future worker job) can use it too.
  `apps/web/src/lib/format-item-id.ts` deliberately keeps its own standalone copy rather
  than re-exporting - re-exporting from `@galm/core`'s barrel broke the production build
  ("Module not found: Can't resolve 'bun'"), since that barrel unconditionally pulls in
  `@galm/db`'s Bun-native Postgres client transitively through any client component that
  imports this file.
- **Verified**: `bun run typecheck` clean across every package, a full Docker rebuild of
  `apps/web`/`apps/worker` (which is what caught the client-bundle regression above -
  typecheck alone didn't), all 35 e2e tests pass (32 existing + 3 new: code immutability
  once a level is in use, cross-kind code-uniqueness, and 20 concurrent creates against
  the same (product, level) landing on exactly `{1..20}` with no duplicates or gaps).
  `scripts/verify-audit-immutability.ts` and `scripts/backfill-tenant-defaults.ts`
  (updated for the merged table's `kind`-scoped queries) both re-run clean against the
  live dev database, the latter confirmed idempotent on a second run.

## Select showing raw UUIDs instead of names (backlog item 9.13)

- **A real, documented Base UI/Radix API difference, tracked down from the source rather
  than guessed at.** Base UI's `Select.Root` accepts an `items` prop -
  `Record<string, ReactNode>` or `ReadonlyArray<{value, label}>` - and its own type
  definition says outright: "When specified, `<Select.Value>` renders the label of the
  selected item instead of the raw value." Every `<Select>` in this app was written
  Radix-style: render `<SelectItem value={x.id}>{label}</SelectItem>` children and expect
  the trigger to just show the matching label, the way Radix's Select infers it
  automatically from rendered children. Base UI does not do that inference - confirmed by
  reading `SelectValue.js`'s `resolveSelectedLabel`, which only consults the `items` store
  state (populated solely from that explicit prop, never auto-derived from mounted
  `Select.Item`s) and otherwise falls back to `stringifyAsLabel(value)`, i.e. the raw
  value itself. For every select in this app keyed by an entity id (test execution
  environment, a requirement's parent) that raw value is a UUID; for the ones keyed by an
  enum string (test type, safety classification) it's a subtler symptom - the un-capitalized
  raw value ("verification") instead of the rendered label ("Verification").
- **Fixed once, at the shared wrapper, not per call site.** `components/ui/select.tsx`'s
  `Select` (previously just `const Select = SelectPrimitive.Root`, a bare re-export) is now
  a real wrapper: `collectSelectItems` walks `children` recursively (through
  `SelectContent`/`SelectGroup`, however deep) collecting `{value, label}` from every
  rendered `SelectItem` it finds, and passes the result as `items` to `SelectPrimitive.Root`
  unless a caller explicitly supplies their own. This makes every existing call site in the
  app - already written the Radix-style way - correct without touching any of them, and
  keeps the Radix-style convention available for future code, so nobody has to remember
  Base UI's `items` requirement when adding a new select. `Select` had to become an
  explicitly generic function (`function Select<Value>(...)`, matching Base UI's own
  `SelectRoot<Value, Multiple>`) rather than staying a bare aliased re-export - without it,
  every call site's `onValueChange` callback parameter lost its inferred type.
- **Verified with a real headless browser, not just re-reading the diff**: opened a test
  execution's Environment select (environment id, a UUID, is the value), selected the one
  real option, and confirmed the trigger displays "Default" - not the environment's raw id.
  All 32 e2e tests and a full Docker rebuild still pass.

## Table filters/sorting via URL state, and remembering the last location (backlog item 9.14)

- **`apps/web/src/lib/use-url-state.ts`** is the one shared mechanism: `setParams(patch)`
  merges a partial update into whatever's already in the URL's query string (never
  clobbering unrelated params like `artifact`/`level`) and calls `router.replace` - not
  `push` - so adjusting a filter doesn't spam the back button with one history entry per
  keystroke. Setting a key to `undefined`/`""` removes it from the URL entirely, so a table
  at its default (unfiltered, unsorted) state produces a clean link rather than
  `?status=&sortBy=&sortDir=` noise. All three tables (`requirements-section.tsx`,
  `test-cases-section.tsx`, `traceability-section.tsx`) use the same generic param names
  (`q`, `status`/`safety`/`type`, `sortBy`, `sortDir`) since only one of them is ever
  rendered at a time - no collision risk, and one mental model across all three.
- **Filtering and sorting are client-side**, over the already-fully-fetched list, not
  pushed to the backend as query params - none of these lists are paginated (a whole
  level's requirements, or a whole product's traceability matrix, already comes back in
  one call), so there's no correctness or performance reason to round-trip a filter to the
  server. Each table has its own small `compare*` function and `useMemo`'d derived array;
  not generic-ized across the three given how different each table's actual sortable
  fields are (a version number, a coverage count, a last-execution date).
- **`SortableTableHead`** (`components/sortable-table-head.tsx`) is the one shared
  click-to-sort column header - clicking toggles direction on the already-active column and
  switches to ascending on any other, the standard spreadsheet convention, with an arrow
  icon indicating the current state (a faint up/down icon when inactive).
- **Traceability's filter is one combined dropdown, not two** ("coverage" and "execution
  status" as separate facets) - deliberately, since a QMS reviewer actually thinks in terms
  of "not covered" / "covered but never run" / "ran and passed/failed/blocked", not two
  independently-crossed dimensions. `matchesStatusFilter` encodes exactly those cases.
  The CSV export was changed to export the *filtered, sorted* rows (`visibleRows`), not the
  raw fetched data - if you narrowed the matrix down to just gaps before exporting, the
  downloaded file matches what you were looking at.
- **Remembering the last location** (`apps/web/src/lib/last-location.ts`) is deliberately
  shallow, per the explicit ask: `localStorage`, not a backend column (a per-device
  convenience, not data anyone else needs or that should follow a user across devices),
  and only `{productId, artifact, levelId}` - never a specific item, an active filter, sort
  order, or scroll position. `products/[id]/page.tsx` (the one place that authoritatively
  knows all three at once) writes it on every change; a small client component,
  `LastLocationRedirect`, renders `null` and redirects on mount if something's remembered -
  added to the otherwise-server-rendered home page so a first-time visit (or one with
  nothing remembered) still shows the normal welcome content instead of the whole page
  needing to become client-rendered just for this one redirect.
- **Verified with a real headless browser, not just re-reading the diff**: sorted a
  requirement list by title (confirmed both the URL gained `sortBy=title&sortDir=asc` *and*
  the actual row order changed), filtered by safety class (confirmed the URL and the rows
  both narrowed correctly), then - the check that actually matters for "shareable" -
  navigated fresh to that exact URL in a new page load and got back the identical
  filtered/sorted rows, not just observed the same client staying in sync with itself. Spot
  checked the identical pattern on test cases (type filter) and the traceability matrix
  (the "not covered" filter correctly isolated exactly one deliberately-uncovered
  requirement out of a mixed set). Confirmed visiting the home page after browsing a
  product redirects straight to that exact product/artifact/level URL. All 32 e2e tests and
  a full Docker rebuild pass throughout.

## Avatar menu crash: DropdownMenuLabel outside a Group (backlog item 9.15)

- **A real, reproducible crash, not a cosmetic bug**: clicking the initials avatar in the
  top-right corner threw "Base UI error #31" and broke the whole menu. Tracked down by
  actually clicking it in a real headless browser and reading the thrown error's stack,
  then finding error code 31's real (dev-mode) message in Base UI's own source
  (`menu/group/MenuGroupContext.js`): "MenuGroupContext is missing. Menu group parts must
  be used within `<Menu.Group>` or `<Menu.RadioGroup>`." - production builds ship only the
  numeric code via a minifier plugin, so the dev-mode string had to be found in
  `node_modules` directly rather than read off the crash itself.
- **Root cause**: `components/context-strip.tsx`'s `UserCorner` used `DropdownMenuLabel`
  (showing the signed-in user's email) as a direct child of `DropdownMenuContent`, with no
  `DropdownMenuGroup` wrapping it. `DropdownMenuLabel` (`components/ui/dropdown-menu.tsx`)
  wraps Base UI's `Menu.GroupLabel`, which - unlike Radix's standalone label primitive -
  requires an actual `Menu.Group` ancestor to read its context from; without one, it
  throws instead of silently rendering unlabeled. This is the only place in the app
  `DropdownMenuLabel` is used, so the bug was isolated rather than systemic.
- **Fixed** by wrapping the label in `DropdownMenuGroup`.
- **Verified with a real headless browser, not just re-reading the diff**: reproduced the
  exact crash first (a genuine thrown error captured via Puppeteer's `pageerror` listener,
  not inferred), then confirmed after the fix that clicking the avatar opens the menu
  cleanly - the email text and a working Sign Out button both present, no error. All 32
  e2e tests and a full Docker rebuild pass.

## Requirement linking UI, and navigation polish

- **Tag/chip requirement picker** (`components/requirement-picker.tsx`,
  `components/ui/combobox.tsx`) replaces the native `<select multiple>` (test-case level)
  and the per-step checkbox popover (step level) with a searchable, Jira-label-style
  picker built on Base UI's `Combobox` (`multiple` mode + `Chips`/`Chip`/`ChipRemove`).
  Requirement ids are the item values directly via `Combobox.createItems({ getValue,
  getLabel })`, so selection stays plain `string[]` with no id<->object translation.
  `ui/combobox.tsx` is a reusable styled wrapper (same convention as `ui/select.tsx`), not
  a one-off.
- **Step-level links** (`RequirementLinkList`, same file) show as compact id chips
  directly in the table cell (full title on hover via a plain `title` attribute) with a
  small `+` trigger opening a popup containing the search input - Base UI's "input inside
  popup" pattern, since a table cell has no room for an inline search box. `Combobox.Chips`
  can render outside any input group, but its `Chip` children must stay nested inside it -
  `useComboboxChipsContext()` is destructured unguarded and throws otherwise (same failure
  shape as the `DropdownMenuLabel`/`Menu.Group` crash above).
- **Real bug found and fixed along the way**: Base UI's Combobox clears the *entire*
  multi-select value when Escape is pressed while its popup is closed (meant for
  in-progress typed text, destructive for already-committed chips) - cancelled via
  `eventDetails.cancel()` on `reason === "escape-key"`. Doesn't reproduce in the step-level
  picker (its input only exists while the popup is open), but the guard stays as defense
  in depth.
- **Test-case edit form**: Save/Discard are `disabled` unless the form differs from a
  `savedSnapshot` taken on every server sync, and the bar is `fixed` to the bottom of the
  viewport (not `sticky`, which stops tracking past the end of the `<form>`) so it stays
  reachable on a long test case without scrolling. `useUnsavedChangesGuard`
  (`lib/use-unsaved-changes-guard.ts`) adds a `beforeunload` prompt plus a capture-phase
  click guard on in-app `<a>` navigation (the App Router has no stable route-blocking API);
  the "Run test" button navigates via `router.push`, not a link click, so it's guarded
  separately. Known gap: the browser back/forward button between two internal routes is a
  client-side transition neither mechanism catches.
- **Requirements page**: the "New {level}" form starts collapsed behind a "+ New {level}"
  button instead of always sitting open ahead of the list; stays open after a successful
  create so adding several in a row doesn't mean re-clicking.
- **Remembering the last level viewed** (`lib/last-level.ts`): a `localStorage` map from
  `productId:artifact` to the last-viewed level id, consulted only when the URL has no
  `level` param of its own (an explicit one, e.g. from the level dropdown, always wins) -
  fixes the Requirements/Test Cases tabs always resetting to the first level. Separate from
  `last-location.ts`'s single "most recent place" slot (the home page redirect), which gets
  overwritten on every tab switch and so can't answer this per artifact.
- Verified throughout against a live Docker rebuild with a real headless browser
  (Playwright; `chromium-cli` wasn't available here): search/select/remove at both link
  levels, the full create -> detail round-trip, Save/Discard's disabled state through
  edit/discard/save cycles, the leave-confirmation dialog, the fixed bar at both scroll
  extremes, and the remembered level surviving a tab switch while a different product's
  stayed unaffected.

## Testing

`tests/e2e.test.ts` (Bun's built-in test runner, no extra dependency) is a fast, server-side
e2e suite: real HTTP requests against a running `apps/web` — no browser — plus direct
Postgres checks for the things that only matter at the database level (immutability, hash
chaining). Each test registers its own fresh tenant, so tests are independent and order
doesn't matter. Run it with:

```
docker compose up -d
docker compose --profile migrate run --rm migrate
bun run test:e2e
```

It exists to replace ad-hoc `curl` exploration with something that actually accumulates:
every backlog item's manual verification should get folded in here as a real test, not
re-typed by hand next time. Current coverage (backlog items 2-3, 13 tests): fresh
registration seeds default statuses and settings correctly; by default (e-signature and
independent review both off) an author can approve their own work with no e-sign; enabling
each setting gates approval accordingly (e-signature: required/valid/replay-rejected;
independent review: self-approval blocked, a different author's version can be approved);
managing statuses (rename, disable, the fixed categories that refuse to be disabled,
disabling a category collapsing transitions around it) is cross-tenant isolated; baselining
freezes further edits/transitions; RLS blocks cross-tenant reads; every transition writes an
independent audit_log row; and the approval_events immutability trigger + hash chain hold up
under direct SQL.

One thing it deliberately does **not** catch: data drift in already-existing rows from
before a migration shipped (see `scripts/backfill-tenant-defaults.ts` and the incident
that prompted it, below) - every test starts from a fresh registration, which always goes
through the current code path. That class of bug needs a backfill migration, not a test.

## Verification

Before any product feature work starts, build a **walking-skeleton spike**: the literal
empty-shell stack — `web` + `worker` + `postgres` under the target Docker base image, one
Drizzle migration via `bun-sql`, one pg-boss job round-trip, one better-auth login, one RLS
policy proven to block cross-tenant reads, one file round-tripped through the local storage
driver. This validates the entire stack bet (especially Bun-in-prod) in one shot rather than
discovering an incompatibility mid-feature. See `BACKLOG.md` item 0 for the concrete
pass/fail checklist.
