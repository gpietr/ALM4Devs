# Backlog

Dependency-ordered build sequence, not a fixed sprint plan — tackle one item at a time, ship
it, then move to the next. See `TECH_STACK.md` for the architecture each item builds on.

Check items off as they're completed; add sub-tasks under an item as it's broken down further
during implementation.

**Testing**: `tests/e2e.test.ts` (`bun run test:e2e`, see TECH_STACK.md's Testing section)
is a fast, server-side e2e suite covering everything verified so far. Each new item should
add its own coverage there rather than relying on manual `curl`/browser verification alone.

- [x] **0. Walking skeleton** — `docker-compose.yml` (web, worker, postgres), Bun workspaces
  scaffold, one Drizzle migration via `bun-sql`, one pg-boss job round-trip, one better-auth
  login, one RLS policy proven to block cross-tenant reads, one file round-tripped through
  the local-filesystem storage driver. De-risks the Bun-in-prod bet before any feature code
  exists. **Done and verified end-to-end via `./scripts/verify-walking-skeleton.sh` against
  real Docker/Postgres** — see TECH_STACK.md for the bugs this surfaced and fixed (auth
  tables can't be under RLS, FORCE ROW LEVEL SECURITY was wrong, DB clients must be built
  lazily, containers need the Postgres service name not `localhost`, pg-boss needs
  database-level CREATE, and root-level scripts need `@galm/db` as an explicit dependency).

  Pass/fail checklist:
  1. `docker compose up` brings up all three services cleanly.
  2. A seed script creates two tenants; a query run as tenant A against tenant B's row IDs
     returns zero rows (proves RLS is actually binding, not just declared).
  3. A trivial pg-boss job enqueued via the web app is picked up and completed by the worker.
  4. A user can sign up (email/password), log in, and a protected tRPC call succeeds.
  5. An audit_log row is inserted, then an UPDATE against it is attempted directly in `psql`
     as the `app_runtime` role and confirmed to fail (proves immutability enforcement, not
     just app-level discipline).
  6. A file is written via the local-filesystem storage driver and read back through the
     signed-URL route handler, proving the storage abstraction works end-to-end without any
     object-storage service running.

- [x] **1. Auth UI (sign-up / log-in)** — combined "create your organization + your
  account" registration page (`/register`, backed by `/api/register` which creates the
  tenant then calls better-auth's sign-up server-side), a log-in page (`/log-in`), a
  session-gated home page that redirects to `/log-in` when signed out, and a sign-out
  button. Tailwind CSS added to `apps/web` for this. **Done and verified against the live
  containers**: register → session cookie → protected home page → sign-out → redirect all
  confirmed end to end.

- [x] **2. Core schema & domain model** — `packages/db` schema for Product, Requirement
  (typed user_need/system_requirement/software_item_spec, safety classification A/B/C,
  parent linkage, identity+version split), and a **customizable status model**:
  `requirement_statuses` is a per-tenant table (name, category, sort order,
  enabled/disabled) seeded with Draft/In Review/Approved/Baselined on sign-up, so a team
  can rename any status or disable a whole category (e.g. skip "Baselined") without a
  schema change. `packages/core` hardcodes only the small set of *categories* the workflow
  needs to know the behavior of (which transitions require e-signature, which freeze the
  version), never specific status rows. **Done and verified end-to-end** against live
  Docker/Postgres, including RLS isolation across tenants for every new table.

- [x] **3. Requirements authoring + approval workflow** — CRUD UI for requirements
  (`/products`, `/products/[id]`, `/requirements/[id]`), inline editing while a version is
  in the draft category (edits create a new version rather than mutating in place), status
  transition buttons driven by the server-computed allowed-transitions set, and a real
  e-signature flow (`/api/reauth` mints a short-lived single-use token after a fresh
  password check; the transition endpoint requires and consumes it before writing an
  `approval_event`). Every transition also writes an `audit_log` row independent of
  approval events, closing a piece of backlog item 7 early. **Done and verified against
  live containers**: full Draft → In Review → Approved (e-signed) → Baselined (e-signed)
  → frozen lifecycle exercised end to end, including a rejected replay of a used re-auth
  token, a rejected edit attempt on a baselined version, a rejected UPDATE on
  `approval_events` as `app_runtime`, and the hash chain and audit trail all checked
  directly in the database.

  **Extended with a `/settings` page**: both e-signature and independent review are
  per-tenant settings (`tenant_settings` table), **off by default** - a tenant opts into
  the stricter process, it isn't forced on them. Independent review blocks approving a
  requirement version you authored yourself. Statuses can be renamed or disabled (except
  Draft/Approved, which anchor the minimum workflow) from the same page.

  **Extended again with user-definable hierarchy levels**: the fixed User Need/System
  Requirement/Software Item Spec enum is now `requirement_levels`, per-tenant rows a team
  can rename, reorder, add to, or delete (the 3 defaults are seeded on sign-up, matching
  the original 3 fixed types). A requirement's parent is optional, chosen from a dropdown
  of same-product requirements at a strictly higher level - enforced server-side, not just
  a UI convention. The product page (`/products/[id]`) now shows one list per level as
  tabs, not a flat list, since different people typically work at different levels. The
  requirement detail page shows the parent (linked) and children (requirements tracing to
  this one). Migrating the existing fixed-enum column with live data (no TTY available for
  drizzle-kit's interactive rename prompt) is written up in TECH_STACK.md.

  Covered by `tests/e2e.test.ts` (21 tests total now) rather than only manual verification
  - see that file and TECH_STACK.md's Testing section.

- [x] **4. Test case authoring + execution tracking** — Test cases live on user-definable
  levels (one "Default" seeded, same pattern as requirement levels but no hierarchy
  concept), each with an ordered list of steps: description, expected result, purpose
  (optional), and requirement links - rich text fields (images/tables/formatting) via a
  Tiptap editor producing sanitized HTML. Linking a step to a requirement automatically
  links the test case (computed at read time, not synced). A test case and its steps can
  also be linked directly. A user-definable environment list (also seeded with one
  "Default") is recorded on every execution. Running a test case snapshots each step and
  walks through them one at a time, recording actual result + Pass/Fail/Blocked + evidence
  **per step** (not per execution) - evidence and rich-text images share one durable
  attachment registry served through a session-authenticated URL that never expires.
  Completion is refused until every step is recorded, and the overall result is a computed
  rollup (fail beats blocked beats pass), not independently settable.

  **Explicit scope cuts**: no approval/versioning workflow on test cases themselves (only
  requirements have that); editing a test case's steps after creation isn't built yet, only
  create-with-steps and execute-against-them; "compatible with Spira" means HTML was chosen
  as the rich-text format for that reason, not that byte-level compatibility with Spira's
  actual export has been verified (that's backlog item 8's job).

  **Done and verified against live containers**: sanitization actually strips a `<script>`
  tag while preserving legitimate formatting (bold, tables); the full create → link → start
  execution → record every step → attempt-too-early-completion-rejected → complete →
  rollup-status flow; evidence upload/fetch round-trips exact bytes and is blocked
  cross-tenant; and test-level/environment settings management (rename, reorder, the
  in-use and last-remaining-one delete guards). Two real bugs surfaced and fixed along the
  way - ten files each independently opening their own connection pool (individually
  correct, collectively exhausting Postgres's connection limit), and the manual-migration
  runner re-executing every file on every run instead of tracking what's already applied -
  see TECH_STACK.md. `tests/e2e.test.ts` is now 29 tests (28, plus one for the Background
  field added alongside item 9 below - Spira import itself needs a real/mock Spira server
  to test against, so it isn't part of this suite; see item 9 and TECH_STACK.md).

- [ ] **5. Defect/Anomaly + Baseline/Release** — defect linking from failing Test Executions
  (just free text for now, assume external system); Baseline/Release as a frozen snapshot of the full
  req+test+result set for a given version.

- [x] **6. Traceability matrix + export** — a product-wide matrix tab (`?artifact=traceability`
  alongside Requirements/Test Cases) computing Requirement ↔ Test Case ↔ Last Execution live,
  as a real `<table>` so it pastes cleanly into a spreadsheet, plus a client-side "Export CSV"
  button. A requirement with no covering test case still gets a row (test/execution columns
  blank) - the point of a matrix is to make coverage gaps visible, not just confirm existing
  coverage. Requirement and test-case list/detail pages also gained direct "covered
  by"/"covers" visibility (counts on the lists, full linked-item lists on requirement
  detail - test case detail already had this via "Traces to"). **Deferred**: Defect linkage
  (blocked on backlog item 5, not built) and a real `packages/export` package (PDF, a
  downloadable server-rendered file) - the CSV button covers "get this into Excel" for now.
  **Verified** against the real API/DB (a requirement covered directly, one covered only via
  a step link, and one genuinely uncovered all resolve correctly, including a real completed
  execution's status showing up as "last execution"); e2e and Docker build pass.

- [ ] **7. Audit log completeness pass** — verify every state-changing mutation across items
  2–6 writes an audit_log row (not just approval events); close any gaps found.

- [ ] **8. Jira integration** — `packages/integrations/jira`: webhook receiver + polling
  reconciliation job, bidirectional status/link sync, field mapping config per project.

- [x] **9. Spira importer (requirements + test cases, REST-only)** — `packages/integrations/spira`:
  a client resilient to Spira's real-world variation (base URL is entirely user-supplied
  since Cloud vs. self-hosted installs differ, custom-field discovery falls back to
  standard fields alone if that endpoint isn't reachable), a per-tenant saved connection
  (`spira_connections` - API key stored in plain text, same trust boundary as the rest of
  this database, no separate encryption layer), and an import wizard
  (`/import/spira`) that fetches the project's actual available fields (standard +
  custom), lets you map each to Title\*/Description\*/Background/Safety Classification
  (required ones enforced before Preview/Run unlock), previews the first page with no
  writes, then commits - continuing past any single row's failure rather than aborting the
  whole batch. Added a `background` field to Requirement alongside this (sanitized rich
  text, unlike the older plain-text `description` - the importer strips HTML entirely,
  rather than sanitizing-and-keeping-tags, when mapping into `description` specifically,
  since that field isn't rendered as HTML).

  **Test case import** added alongside requirements, reusing the same saved connection:
  `SpiraClient.listTestCases`/`listTestSteps` (`GET /projects/{id}/test-cases` and
  `GET /projects/{id}/test-cases/{test_case_id}/test-steps`, both confirmed against a real
  Spira instance), and custom-field discovery generalized to any artifact type name
  (`Requirement`, `TestCase`, `TestStep` all use the same
  `/project-templates/{id}/custom-properties/{artifact_type_name}` endpoint). Our test case
  model has no case-level description field, so only **Title** is a chosen mapping; every
  step's Description and Expected Result are always read directly (they're what's
  fundamentally being imported, not a choice); **Purpose** is the one optional per-step
  mapping, sourced from any Test Step field including a custom one (a real Spira project
  used for verification had exactly this: a custom "Purpose" text field on Test Step).
  Test Type (verification/validation) and Test Level are fixed choices applied to the whole
  import batch, not sourced from Spira - its own test case type taxonomy doesn't map onto
  our two-valued split. A Spira test case with zero steps is skipped with a clear per-row
  message (our model requires at least one step) rather than failing the whole batch.

  **Re-importing updates instead of duplicating**, for both requirements and test cases:
  each imported row's Spira id is recorded in a new generic `external_links` table (not
  Spira-specific - the same shape a future Jira sync would need), so re-running an import
  looks up whether that id was already imported and reconciles the existing row in place
  rather than creating a duplicate. Nothing changed since the last import reports
  `"unchanged"` and writes nothing. A requirement that moved past Draft is `"skipped"` with
  the reason (re-import respects the same edit rule a manual edit would). Test case steps
  are matched by their own recorded external id and updated in place; a step removed at the
  source is left alone locally, not deleted (`test_step_executions` isn't safe to cascade
  through, and silently deleting steps isn't safe regardless). This also lays the
  groundwork for a future sync-*back* feature (writing local changes to Spira) - the id
  mapping now exists for that, but the write-back itself is not built.

  **Explicit scope cuts**: no traceability-link import (neither requirements' nor test
  cases' links to each other import); no sync-back (see above); REST only, no SOAP fallback
  for older self-hosted instances; the field mapping itself is chosen fresh per import run,
  not persisted (the *connection* is, the mapping isn't - custom fields vary per Spira
  project, so a saved mapping wouldn't travel between customers anyway); "run" is a single
  synchronous request that pages through the whole project internally (100 rows/page,
  capped at 20,000 rows as a runaway-loop safety net, not a normal-path limit) rather than a
  background job - fine for the dataset sizes this product targets, but a genuinely huge
  project would want this moved to a pg-boss job with progress polling instead of one
  long-lived HTTP request; test case import is inherently one Spira request per test case
  for its steps (no bulk "all steps for a project" endpoint exists), acceptable at these
  dataset sizes.

  **Verified against both a real (mock) Spira server and the user's actual production
  Spira instance.** Mock server: full requirements flow (save connection, test connection,
  discover standard + custom fields, preview, commit) confirmed end to end, including a
  150-row mock project spanning two 100-row Spira pages, confirming "Import all" pages
  through automatically (all 150 created, 0 errors) rather than stopping at one page. Real
  instance (with the operator's own credentials, used only transiently to drive the
  already-running app's own API - never written to any version-controlled file, stored
  only in the app's own `spira_connections` table like any other saved connection):
  connected to a real 71-test-case project, discovered its real custom fields (a "Purpose"
  text field on Test Step, confirming the generalized custom-field discovery), previewed
  real test cases with real HTML-formatted steps, and ran a full import - all 71 test cases
  and their steps created with 0 errors, matching the real project's own test case count
  exactly.

  **Idempotent re-import verified against a mock server with mutated content between two
  runs**: database row counts confirmed not to double on a second run; a requirement with
  genuinely changed content came back `"updated"` (new version), an untouched one came back
  `"unchanged"`; a test case with one edited step and one newly-added step came back
  `"updated"` with an accurate per-step breakdown, an untouched one came back `"unchanged"`;
  and a requirement moved to In Review before its source changed came back `"skipped"` with
  the same message a manual edit attempt would get, while a still-Draft requirement in the
  same run updated normally.

- [x] **9.5. Navigation & information architecture** — every screen after login used to be
  an island: no shared nav, each page hand-wrote its own single "← Back" link to one parent,
  so a requirement/test-case/execution page had no way to reach Settings or Import without
  walking all the way back Home first. Designed and reviewed as a Mermaid diagram + a
  clickable mockup before any code changed (see the "Galm Navigation Blueprint" artifact
  from that session), then built as:
  - A small, quiet **context strip** (`@/components/context-strip`: `TopBar` +
    `ProductContextStrip`) rendered by each page itself (not a shared layout slot - the
    content varies too much page to page for that to be worth the Context-plumbing): a
    rarely-used product switcher, then the Requirements/Test Cases toggle, then level tabs
    scoped to whichever of those is active. Requirements and Test Cases are genuinely
    separate contexts - picking one swaps the level set entirely, never both at once,
    matching how people actually work (one product, one level, held for a stretch).
  - Level/artifact selection on the product page moved from local `useState` to the URL
    (`?artifact=&level=`) - shareable, and the single source of truth the context strip's
    links and the page's data-fetching both read from, instead of two places agreeing by
    convention.
  - `apps/web/src/app/(app)/layout.tsx` is a new route group covering everything except
    `/log-in` and `/register`, checking the session once and redirecting if absent - a
    real gap fixed as a side effect, since previously only the home page bothered to do
    this and every other page just let a `protectedProcedure` call fail with UNAUTHORIZED.
  - Spira import moved from its own top-level page to `/settings/import`, linked from a
    section inside Settings - it's an occasional action, not a peer to Settings itself.
  - Sign-out moved from a home-page-only button into the context strip's avatar menu
    (reusing the existing `SignOutButton`), so it - like everything else here - is now
    reachable from anywhere, not just Home.

  **Verified against live containers**: full rebuild + migration-free (no schema changes -
  this is frontend-only), all 29 e2e tests still passing, and every affected route checked
  directly (register → create a product/requirement/test case/execution → load each page
  with real ids, confirming 200s with no error markers and the context strip's real content
  in the server-rendered HTML) plus confirming `/import/spira` now 404s and `/settings/import`
  serves the moved wizard.

- [x] **9.6. UI component library and design tokens** — adopted shadcn/ui (named in the
  original tech-stack plan but never installed until now): `button`, `input`, `textarea`,
  `label`, `select`, `card`, `badge`, `dialog`, `dropdown-menu`, replacing 13 repeated
  primary-button classnames, 10 secondary-button classnames, 21 card/list-item classnames,
  28 input classnames, and three independent hand-coded status-color maps (now `StatusPill`
  + `ResultBadge`, both thin wrappers over one `Badge` with added `success`/`warning`/`info`
  variants matching the app's existing soft-pill look). `EsignModal` moved from a hand-rolled
  fixed-overlay `<div>` to shadcn's `Dialog` (real focus trap + Escape + `aria-modal`, not
  just a reskin); `ContextStrip`'s three `<details>` dropdowns moved to `DropdownMenu`.

  **Design tokens**: one deliberate teal accent (continuing the Navigation Blueprint
  artifact's reasoning - clinical precision + traceability - not shadcn's default grayscale
  `--primary`, not a generic Linear-indigo or Vercel-black), spent only on buttons/links and
  focus rings; IBM Plex Sans + IBM Plex Mono self-hosted via `next/font/google` (mono
  reserved for identifiers - requirement/test-case ids, version numbers), not Geist
  (shadcn's own default) or Inter (the generic "safe" choice), and specifically not a
  runtime Google Fonts CDN link - wrong for a product that ships as a self-host Docker
  image. Light-only, matching the app's existing `color-scheme: light` - dark mode is a
  clean follow-up, not part of this pass.

  **Explicit scope cuts**: multi-select requirement pickers stayed native `<select
  multiple>` for this pass (no headless-UI equivalent existed yet - later replaced by a
  searchable tag/chip combobox, see TECH_STACK.md's "Requirement linking UI" section); the
  Requirements/Test Cases toggle stays styled `<Link>` pills, not `Tabs` (it's real
  navigation, not client-side panel switching); `RichTextEditor`/`RichTextView` (Tiptap)
  untouched - a rich-text engine, not a form primitive.

  **A real bug surfaced along the way**: shadcn's init added token-based `body` styling in
  a CSS layer, but an older *unlayered* `body` rule already set the same properties directly
  - unlayered CSS always wins over layered CSS regardless of source order, so the new
  tokens were silently inert until the old rule was trimmed down to just `antialiased`.

  **Verified against live containers**: `next build` succeeded (catches Tailwind v4/Base UI
  integration issues a plain typecheck wouldn't), all 29 e2e tests still passing (pure
  UI-layer change), and all eleven user-facing routes - including `/log-in`/`register`,
  migrated too for consistency - hit with real ids from a fresh registration, confirming
  clean 200s with no error markers. No headless browser available here, so real interaction
  quality (focus trap, keyboard nav on the new dropdowns/select) needs a human look.

- [x] **9.7. Visual style: Slate & Indigo, flat buttons, dividers not cards** — the shadcn
  adoption's own default look still read as generic; explored via a second review artifact
  (live before/after of one screen, live buttons, three color candidates) before touching
  code, same pattern as the navigation pass. Shipped: the teal accent replaced with a
  desaturated navy-indigo on a faintly cool-slate page background (not stark white -
  the white-on-white was as generic as the hue); a 3D button treatment built, shown, and
  explicitly rejected in favor of a flat fill with a real darken-on-hover; outline/ghost
  buttons and shadcn's own menu/select hover token retinted toward the accent so every
  interactive control reads as one family; `--radius` tightened app-wide via one token;
  `Card` lost its ring/shadow for a plain border; simple navigational list rows (products,
  requirements, test cases, version history, execution history, settings lists) moved off
  `Card` entirely onto one shared divided-list pattern, while genuine content blocks (forms,
  step content, step-execution cards, Spira preview rows) kept `Card`; version numbers and
  trace links now carry the accent color, so it shows up in the data, not just the button.

  **Verified against live containers**: rebuilt, `next build` succeeded, all 29 e2e tests
  still passing, all ten routes hit with real ids returned clean 200s, and the actual
  compiled CSS served by the running container was fetched and checked directly to confirm
  the new radius and accent color are really in the shipped stylesheet.

- [x] **9.8. Real-use fixes: breadcrumbs, button alignment, editor selection bug, version
  diff** — four things found by actually using the shipped app rather than by review.
  - The context strip's level dropdown was supposed to double as "back to the list," but
    clicking an already-active pill isn't discoverable as a "go back" action. Restored an
    explicit `← Back to {level name}` breadcrumb on the requirement and test-case detail
    pages, and `← All products` on the product page - the strip is for switching context,
    the breadcrumb is for returning.
  - The "Run test" button next to the Environment dropdown was visibly misaligned - fixed
    by giving it its own matching label+control column (an invisible label above it)
    instead of relying on flex cross-axis alignment across two differently-shaped columns.
  - "I select bold by mistake" turned out to be two bugs: the toolbar buttons had no
    `onMouseDown` guard (a real, textbook Tiptap bug - clicking one stole focus from the
    editor and changed the selection before the click handler ran), fixed with the
    standard `onMouseDown={(e) => e.preventDefault()}` guard; then the reported "still bold
    by default" after that fix was a second, unrelated bug - shadcn's `Label` ships
    `font-medium`, and four call sites use `Label` as a stacking wrapper around a whole
    `RichTextEditor`, so the inherited font-weight silently bolded every typed character
    with no `<strong>` mark involved. Fixed at the source: `RichTextEditor`/`RichTextView`
    now set `font-normal` on their own root element instead of patching four call sites.
  - Version history now shows a Spira-style redline: a "Show changes" toggle per version
    revealing a word-level diff (added/removed highlighting) against the previous version,
    for title, description, and background - no schema change, the data was already
    fetched, just a new diff component using the `diff` package.

  **Verified**: rebuilt, all 29 e2e tests still passing, breadcrumb hrefs and level names
  confirmed against real `requirements.get`/`testCases.get` responses, and the diff
  algorithm run directly against a real two-version requirement created through the actual
  `editDraft` mutation (not just reasoned about) - correctly isolated the changed word and
  the appended clause.

- [x] **9.9. Rich-text editor: swapped to a maintained component, fixed real focus/sizing
  bugs** — replaced the hand-rolled Tiptap toolbar with the community `shadcn-minimal-tiptap`
  registry component (ships `ResetMarksOnEnter`/`UnsetAllMarks`, purpose-built for the "a
  mark like bold keeps applying after the cursor moves" bug class that kept resurfacing
  under the old homebrew one). Required a Tiptap v2→v3 upgrade; dropped toolbar features
  that produce markup `sanitizeRichText` strips anyway (text color, headings 4-6,
  horizontal rules, markdown paste). `RichTextEditor`'s external API is unchanged, so no
  call site needed edits. Real use then found and fixed: an oversized toolbar (shrunk to
  the old footprint); a heading-menu popup that opened full page-width (Base UI's portal
  positioning resolving `w-full` against the viewport instead of the button); a genuine
  "can't type, focus jumps to the toolbar" bug traced to Radix-style children composition
  producing invalid nested `<button>`s under this app's Base UI (fixed with the `render`
  prop, the correct polymorphism convention here); and a still-not-fully-explained
  transient focus blip on the first toolbar element, worked around by keeping a plain
  toggle button first. Tab now skips the toolbar entirely and lands on the text. **Verified**
  with a real headless Chrome (`puppeteer-core`) actually clicking, typing, and tabbing
  through the live app, not just a successful build; e2e and Docker build pass.

- [x] **9.10. List/detail UX: tabular lists with IDs, clear links, edit-mode-by-default** —
  the product page's requirement/test-case lists became real `<table>`s (ID, title, status,
  safety class, version, "traces to") instead of plain link rows - a real gap for a
  traceability tool, where seeing an item's ID matters. Title and "traces to" links are now
  styled to actually look like links (primary color, underline on hover) instead of plain
  text with a hover effect. Requirements now open straight into their edit form when the
  current version is still draft, instead of a read-only landing that needed an extra
  "Edit" click; anything locked past draft opens read-only with an explicit reason shown
  rather than a silently-missing Edit button. **Verified** against the real API (list
  queries return the ids/fields the tables render) and a real headless browser (a draft
  requirement opens pre-filled and editable, an approved one opens locked); e2e and Docker
  build pass throughout.

- [x] **9.11. Test case editing: tabular, inline-editable steps** — test cases had no edit
  capability at all until now. Added `updateTestCase` (`packages/core/src/test-cases.ts`) -
  a full-replace update for title, type, requirement links, and the whole step list in one
  call, since reordering is just resubmitting it in a new order. Removing a step that's
  already been executed is refused with a clear message (its `test_step_executions` row has
  no cascading delete - historical evidence must stay resolvable) rather than surfacing a
  raw DB error; editing an executed step's own text is still fine, since steps were never
  versioned. The step editor (`components/test-steps-editor.tsx`, shared with the "new test
  case" page) is a real table, one row per step: read-only by default with an edit icon to
  open a row for changes (avoids mounting a rich-text editor - toolbar and all - for every
  step at once), reorder via up/down icons, delete via a trash icon, requirement links in a
  small popover, and Purpose downgraded to plain text (it never needed to be rich HTML).
  Getting the table to actually lay out correctly took a few real rounds of CSS fixes -
  `table-fixed` layout, giving an editing row's fields a combined full-width cell instead of
  two narrow ones so the toolbar has room, and (the actual root cause of text getting cut
  off) removing an inherited `whitespace-nowrap` that was silently preventing long
  descriptions from wrapping at all. The test-case detail page always opens in edit mode -
  test cases have no locked state to gate on. **Verified**: real API round-trips (reorder,
  edit, add, delete, the executed-step-deletion guard, requirement links) and real
  headless-browser checks confirming editors mount on demand, the layout doesn't overflow,
  and long text wraps instead of being clipped. Docker build + e2e pass throughout.

- [x] **9.12. Sequential per-level human-readable ids (SYSREQ-1, TC-1, ...)** — every
  requirement and test case now gets a permanent id: a per-level code (editable in
  Settings, e.g. "SYSREQ") plus a sequence number scoped to (product, level) that's
  assigned once, atomically, and never reassigned, reordered, or reused - not even if the
  item is later deleted. Backed by a new `level_sequence_counters` table and a single
  `insert ... on conflict do update ... returning` per creation (in the same transaction as
  the item, so a failed creation rolls the number back too instead of burning it). The
  code and number are joined at *read* time (`${code}-${number}`), not stored as one
  string, so editing a level's code in Settings changes how everything under it displays
  going forward without touching the immutable numbers underneath. Shown everywhere a
  requirement or test case appears - list tables, detail page headers, parent/child/
  covering-test-case references, requirement-link pickers, and the traceability matrix
  (including its CSV export).

  **Migration backfilled real, live data, not just fresh installs**: existing levels got
  sensible codes (the three seeded requirement levels and the seeded test level got
  friendly defaults; anything else gets a generic derived code, de-duplicated if two
  levels would otherwise collide), and existing requirements/test cases got sequence
  numbers assigned in creation order, with the counters seeded to match so future inserts
  continue correctly. Run for real against this session's own accumulated dev data (4700+
  levels, 1500+ requirements/test cases across many tenants) with zero errors and zero
  constraint violations - not a small-scale sanity check.

  **A real bug found via the new e2e coverage, not just re-reading the diff**: the
  duplicate-code-rejection path was silently broken - Bun's Postgres driver reports the
  generic `ERR_POSTGRES_SERVER_ERROR` in `.code` and the actual SQLSTATE in `.errno`
  instead (confirmed by deliberately triggering the error and inspecting it directly, not
  guessing), so the original `"code" in err` check never matched. Fixed to check both
  `.code` and `.errno` down the `.cause` chain. **Verified**: `bun run typecheck` clean,
  full Docker rebuild clean, all 32 e2e tests pass (3 new, covering per-product
  independent numbering and the now-actually-working duplicate-code rejection); a real
  headless browser confirms the formatted id renders on the requirement list, requirement
  detail, test case detail, traceability matrix, and settings pages.

  **Follow-up architecture review, applied before more code built on this shape**:
  `requirement_levels`/`test_levels` merged into one `levels` table (`kind` column) so
  `level_sequence_counters.level_id` is a real FK and a level's `code` is unique across
  the whole tenant, not per-kind (a requirement level and a test level could previously
  share a code and produce an ambiguous id); a level's code is now immutable once any
  item has been created under it; `unique (product_id, level_id, sequence_number)` added
  as an independent database-level guarantee alongside the atomic counter; a branded
  `TenantTx` type makes "must run inside `withTenant`'s transaction" a compile-time check
  instead of a doc comment; the Spira importers now open one transaction per row instead
  of one for the whole run (the old version held the sequence counter and the audit-log
  advisory lock for the run's full duration, and didn't actually isolate per-row
  failures); `requirement.created`/`test_case.created` audit payloads now stamp the full
  display id so the record stays self-describing after a later code rename. Full details,
  including the live-data migration verification and the client-bundle regression a full
  Docker rebuild caught (that `bun run typecheck` alone did not), in TECH_STACK.md's
  "Follow-up: architecture review and hardening". **Verified**: `bun run typecheck`
  clean, full Docker rebuild clean, all 35 e2e tests pass (3 new: code immutability,
  cross-kind code uniqueness, and a 20-way concurrent-create test against the same
  (product, level)); migration re-run for real against this session's live dev database
  (5671 + 1955 existing rows) with zero orphaned references and zero data loss;
  `scripts/backfill-tenant-defaults.ts` re-verified idempotent.

- [x] **9.13. Dropdowns were showing raw UUIDs instead of names** — a real, documented Base
  UI API gap, not a typo: unlike Radix, Base UI's `<Select.Value>` doesn't infer the
  trigger's displayed label from the rendered `<SelectItem>` children - without an explicit
  `items` prop on `<Select.Root>`, it shows the raw `value` instead, which for every select
  in this app keyed by an entity id (environment, parent requirement, level) is a UUID.
  Every call site was written Radix-style (render `SelectItem`s and expect the trigger to
  just work), so fixed once at the shared `Select` wrapper
  (`components/ui/select.tsx`) instead of retrofitting an `items` array onto each call
  site: it now walks its own rendered children to auto-derive `{value, label}` pairs for
  Base UI's `items` prop. **Verified with a real headless browser**: selecting a test
  execution's environment (a UUID-valued select) now shows "Default" in the trigger, not
  the environment's raw id. All 32 e2e tests and a full Docker rebuild still pass.

- [x] **9.14. Table filters and sorting, saved to the URL; remembering the last
  product/artifact/level** — the requirement, test-case, and traceability tables all gained
  a filter bar (status/safety class/search for requirements; type/search for test cases;
  a combined coverage-and-result status/search for traceability, including a "not covered"
  option that isolates real gaps) and click-to-sort column headers (a shared
  `SortableTableHead`). All of it lives in the URL (`use-url-state.ts`), not component
  state - a filtered, sorted view is a real link someone can be sent directly to, and
  reloading or opening it fresh reproduces the exact same rows. Filtering/sorting happen
  client-side over the already-fully-fetched list (none of these are paginated), not
  pushed to the backend as query params. Separately, the app now remembers only the
  high-level "where was I" - product, artifact type, level - in `localStorage`
  (deliberately not deeper state: no remembered filters, sort, or specific item), and the
  home page redirects a returning user straight back there instead of showing the generic
  welcome screen.

  **Verified with a real headless browser**: sorted a requirement list by title and
  confirmed both the URL (`sortBy=title&sortDir=asc`) and the actual row order updated;
  filtered by safety class and confirmed the URL and rows narrowed correctly; **reloaded
  fresh from that exact URL** (a real new navigation, not just client state) and got the
  identical filtered/sorted view back - proving it's actually shareable, not just visually
  appearing to work; same pattern spot-checked on test cases (type filter) and the
  traceability matrix (the "not covered" gap filter correctly isolated exactly the
  uncovered requirement); and confirmed visiting the home page after browsing a product
  redirects straight back to that exact product/artifact/level. All 32 e2e tests and a
  full Docker rebuild pass throughout.

- [x] **9.15. Clicking the avatar (initials) menu crashed** — a real bug, present since the
  navigation redesign first switched the top-right menu to shadcn's DropdownMenu: the
  dropdown's email line used `DropdownMenuLabel` directly inside `DropdownMenuContent`, with
  no `DropdownMenuGroup` wrapping it. `DropdownMenuLabel` wraps Base UI's `Menu.GroupLabel`,
  which - unlike Radix's standalone label - throws if it's not actually inside a
  `Menu.Group` ("Base UI error #31: MenuGroupContext is missing"). Fixed by wrapping the
  label in `DropdownMenuGroup`. **Verified with a real headless browser**: reproduced the
  exact crash first (a real thrown error, not a guess), then confirmed after the fix the
  menu opens cleanly showing the email and a working Sign Out button, no error. All 32 e2e
  tests and a full Docker rebuild pass.

- [x] **9.16. Spira import: optionally reuse a legacy id as this system's own id** — a
  team migrating from Spira often already has a custom field holding their own pre-
  migration id (e.g. "SYS-104") and wants imported items to keep showing that number here,
  not restart from 1. Added an optional "Legacy ID" field mapping (same generic
  field-mapping mechanism as every other optional field) on both the requirement and test
  case import screens.

  **Simplified once already, based on real feedback**: the first version gave
  `createRequirement`/`createTestCase` a `requestedSequenceNumber` param that tried to
  claim a number and fell back on collision (a per-row existence check plus a used/not-
  used flag threaded through both create functions). Replaced with a smaller design:
  **sort the import rows by legacy number ascending, and bump the shared counter to just
  below each one before creating it, in that order.** Starting from an empty level and
  processing strictly ascending, every row's target is free by construction - no
  collision check, no fallback path, and `createRequirement`/`createTestCase` stay
  completely unmodified. `runSpiraImport`/`runSpiraTestCaseImport` switch to this ordered
  mode only when Legacy ID is mapped (fetching every row up front instead of streaming
  page-by-page, since the whole set has to be sorted before anything is written); the
  default, unmapped path is untouched. Only works importing into a (product, level) with
  no items yet - new `productLevelHasRequirements`/`productLevelHasTestCases` checks
  refuse the run up front otherwise, rather than silently producing large, surprising
  gaps by bumping the counter over an existing item's range.

  **Verified**: a new `scripts/verify-legacy-id-import.ts` (this mechanism can't go
  through the normal black-box e2e suite, which never reaches internal-only import
  machinery - see the script's own docstring) run for real against the live dev database:
  three legacy numbers given out of order land exactly on their own numbers once sorted
  and created; the empty-level precondition check is false before creating anything and
  true after; a duplicate legacy id within one batch rolls the second row forward instead
  of colliding; a direct SQL check confirms zero duplicate sequence numbers at the end -
  for both requirements and test cases. `parseLegacySequenceNumber` (the trailing-digit
  parser) checked against bare numbers, prefixed values, a year-prefixed edge case, and
  non-numeric/zero/negative-looking input. `bun run typecheck` clean, full Docker rebuild
  clean (client-bundle regression watched for specifically, given the earlier incident
  this session while building the first version - none this time), all 35 e2e tests still
  pass.

- [x] **9.17. Settings had no way back to the rest of the app** — every other top-level
  page (Products) has a "Back home" link next to its heading; Settings was missing the
  equivalent, so a user who opened it (via the avatar menu's gear icon) had no in-app path
  out other than the browser's own back button. Added the same `Link href="/"` "Back
  home" pattern already used on the Products page, right next to the Settings heading -
  `/` then resolves via `LastLocationRedirect` back to whichever product/artifact the user
  was last looking at, same as it does everywhere else this link appears.
  **Verified**: `bun run typecheck` clean, full Docker rebuild clean; confirmed the
  compiled client bundle for the settings page actually contains the new link text
  (the page fetches its data client-side, so a plain HTTP fetch only ever shows the
  loading shell - checked the shipped `.next` chunk directly instead, the same chunk
  already containing it on the working Products page for comparison). All 35 e2e tests
  still pass.

- [x] **9.18. Spira import: Spira's own entity id wasn't mappable, and the single import
  page was unwieldy** — real feedback after using the importer: (1) Spira's own built-in
  `RequirementId`/`TestCaseId` (the id Spira itself always assigns, no custom field setup
  needed) wasn't in the field-mapping dropdowns at all, only custom fields were, which
  blocked the obvious no-configuration way to reuse Spira's own numbering via the Legacy
  ID mapping (backlog item 9.16). Added both as standard fields
  (`packages/integrations/spira/src/client.ts`'s `STANDARD_REQUIREMENT_FIELDS`/
  `STANDARD_TEST_CASE_FIELDS`), labeled "(Spira's own)" to read as distinct from a
  same-purpose custom field a team might also have. (2) The one page holding connection
  setup plus the entire requirement AND test-case import flows (target/mapping/preview/
  run, twice) had grown long and made the test-case section's own mapping options easy to
  miss underneath the requirements section above it.

  **Split into three screens with real navigation between them**, not tabs on one page:
  `/settings/import` is now a hub (connection setup, saved once) with two cards linking
  to `/settings/import/requirements` and `/settings/import/test-cases`, each a full
  screen for that one import job with its own "← Import" breadcrumb back to the hub.
  Shared UI (the field-mapping dropdown, the read-only "connected as project X" status
  note each sub-screen shows instead of re-rendering the whole connection form, and the
  import-result-row helpers) factored into `apps/web/src/components/
  spira-import-shared.tsx` rather than duplicated across the two new page files.
  **Verified**: `bun run typecheck` clean, full Docker rebuild clean (all three routes
  build as separate Next.js pages), all 35 e2e tests still pass; confirmed with a real
  registered tenant that all three routes return 200, and that the compiled bundles for
  the two import screens actually contain the new "Requirement ID"/"Test Case ID" field
  labels.

- [x] **9.19. Tenant-defined custom fields for requirements and test cases** — teams need
  fields beyond the fixed built-in set (title, description, safety classification, ...),
  and what they need varies enough between teams that it has to be user-defined, not a
  fixed list. Each tenant can now add named fields per entity type (requirement or test
  case), each with a type (short text, long text, single-choice list with admin-defined
  options, date, integer, yes/no), an optional/required flag (optional by default), and a
  position among the tenant's other fields for that entity type. Defined fields show up
  automatically on that entity's create form (in the order set in Settings), are editable
  after creation independent of the entity's own edit flow, can be added as extra columns
  (a column-picker popover) on the requirement list, the test case list, and the
  traceability matrix - including the matrix's CSV export - and can be mapped to during
  Spira import, same generic field-mapping mechanism as every other optional import field.

  **Storage**: three new tables (`custom_field_definitions`, `custom_field_list_options`,
  `custom_field_values`) - the same "tenant-owned ordered list" shape `levels`/
  `requirement_statuses`/`test_environments` already use elsewhere in this schema, not a
  new pattern. A list field's stored value is the chosen *option's id*, not its text, so
  renaming an option is always free (nothing referencing it has to change) and only
  deleting an option still in use is blocked - deleting the whole field, by contrast,
  cascades its values away with it (there's nothing left dangling), so that's allowed
  outright, with the settings UI's confirm dialog spelling out that this is real,
  permanent data loss.

  **Deliberately not versioned** (packages/db/src/schema.ts's `customFieldDefinitions`
  docstring has the full reasoning): closer in spirit to `requirements.
  safetyClassification` than to the title/description/background that get a new version
  and an approval-workflow status on every change - real content, but metadata a team
  corrects directly. Keeps the feature symmetric between requirements and test cases,
  since test cases have no versioning concept at all to hang it on. `setCustomFieldValues`
  (packages/core/src/custom-fields.ts) reconciles the *complete* set of a tenant's defined
  fields against whatever the caller sends on every call (a field simply left out is
  treated as cleared), enforcing required-ness across every defined field regardless of
  whether the caller even mentioned it - both the create forms and each detail page's
  separate "Custom fields" edit section always submit the full set, matching that
  contract.

  **Verified**: 5 new e2e tests (definition CRUD including the per-entity-type name-
  uniqueness domain; list-option rename-is-always-safe vs. delete-while-in-use-is-blocked;
  required-field enforcement on both create and update, plus type validation, for
  requirements; the same value round-trip for test cases; cascade deletion of a whole
  field). Two new scripts/verify-*.ts (this session's established pattern for internal-
  only mechanisms the black-box e2e suite can't reach) run for real against the live dev
  database: the Spira-import custom-field resolver (case-insensitive list-option text
  matching, a stale/deleted mapped field silently skipped, and the full parse-resolve-
  create-read chain). `bun run typecheck` clean across all 9 packages, full Docker rebuild
  clean (including the new `/settings/custom-fields` route), all 40 e2e tests pass.

- [x] **9.20. Legacy ID import: allowed into a level that already has entries** — the
  ordered/legacy-id-preserving import mode (backlog item 9.16) originally refused to run
  at all once its target (product, level) had anything in it, since bumping the counter
  to a claimed number could jump straight over an existing item's range. That made the
  mode useless for the most natural use case - re-running an import, or running it
  alongside items created directly in this system. Removed the precondition
  (`productLevelHasRequirements`/`productLevelHasTestCases` deleted from
  packages/core/src/level-sequences.ts - no longer had any caller) and let the existing
  per-row mechanism do the right thing on its own, which it already did: a row already
  imported before (matched by Spira id) is **updated** in place, never touching its
  existing sequence number; a genuinely new row claims its requested number when free;
  and a requested number that's already taken - by another row in this batch, an earlier
  import, or something created directly here - doesn't fail the row, it's simply **added
  with the next available number instead** ("duplicate IDs ignored", now stated plainly
  in the per-row result and in the mapping screen's own help text on both import
  screens). One honest limitation documented rather than hidden: a requested number at or
  below wherever the counter already sits (because something occupies that range) always
  rolls forward - there's no attempt to backfill a gap below the counter.

  **Verified**: `scripts/verify-legacy-id-import.ts` extended with real live-database
  checks for the previously-impossible-to-test case - importing into a level that
  already has items: a legacy id colliding with something that existed *before this run*
  (not just another row in the same batch) rolls forward correctly with zero duplicates,
  and re-importing the same Spira id updates the existing row in place with its sequence
  number unchanged, rather than creating a second one. `bun run typecheck` clean, full
  Docker rebuild clean, all 40 e2e tests still pass.

- [x] **9.21. Bug: re-importing with a newly-mapped custom field reported "0 updated"
  even though the value was actually written** — a real bug, reported by a user testing
  the custom-fields feature (backlog item 9.19) right after adding it: map a custom field
  for the first time, re-run an import against rows already imported before (title/
  description unchanged), and the result said "0 updated" - looking like nothing
  happened, when the custom field value had in fact been set correctly.
  `createOrUpdateRequirementFromImport`/`createOrUpdateTestCaseFromImport`
  (packages/core/src/requirements.ts/test-cases.ts) already called `setCustomFieldValues`
  unconditionally on every re-import (custom fields aren't versioned or status-gated, so
  there was never a reason not to reconcile them every time) - but its result was
  discarded, and the "unchanged" vs "updated" action was decided purely by comparing
  title/description/background, with no way to know a custom field had changed.

  Fixed at the source: `setCustomFieldValues` now returns whether it actually wrote
  anything (comparing each field's new value against what was already stored, not just
  assuming a write happened), and both import functions fold that into their action
  decision - a re-import that only changed a custom field now correctly reports
  "updated," and one where truly nothing changed (including custom fields) still
  correctly reports "unchanged." As a side effect, this also means `setCustomFieldValues`
  no longer issues a write for a field whose value didn't actually change.

  **Verified**: extended `scripts/verify-custom-field-import-resolution.ts` (this can't go
  through the e2e suite - `createOrUpdateRequirementFromImport` is only reachable through
  the Spira import path, which needs a real/mocked Spira server) with 4 new checks run for
  real against the live dev database: a true no-op re-import still reports "unchanged"; a
  custom-field-only change reports "updated," not "unchanged"; and the written value is
  confirmed correct on read-back, matching the reported action. `bun run typecheck` clean,
  full Docker rebuild clean, all 40 e2e tests still pass, the other affected
  verify-legacy-id-import.ts script (which also calls the same import functions)
  re-verified with no regressions.

- [x] **9.22. Bug: a mapped custom field still silently never resolved a value, even
  after 9.21** — the user re-tested after 9.21 shipped (a mislabeled-action bug) and hit
  "still nothing updated," which meant the underlying value itself was never resolving,
  not just mislabeled. Root cause: `readSpiraField`
  (packages/integrations/spira/src/client.ts) only ever read a Spira custom property's
  `StringValue` - but Spira's REST API puts a custom property's actual value under
  whichever *type-specific* key matches that property's own type in Spira -
  `IntegerValue` for a Number custom field, `BooleanValue` for Yes/No, `DateTimeValue`
  for Date, `DecimalValue` for Decimal - never `StringValue` unless the Spira field is
  itself plain Text. Any custom field the user actually mapped that wasn't Text silently
  read `null` forever, with no error anywhere to surface it - exactly "I mapped it and
  nothing updated."

  Fixed by reading whichever value key is actually populated (checking `!= null`, not
  truthiness, since a real value can be `false` or `0`), and widening `SpiraArtifact`'s
  `CustomProperties` type to declare all of them instead of just `StringValue`. Spira's
  `DateTimeValue` comes back as a full ISO datetime, not a bare date, so our own `date`
  custom field type's validation (packages/core/src/custom-fields.ts) was also loosened
  to accept a leading `YYYY-MM-DD` prefix and store just that, rather than rejecting
  anything with a time component. One known, documented gap left deliberately unsolved: a
  Spira "List" custom property's value comes back as just the selected item's numeric id
  (`IntegerListValue`), not resolvable to display text without a separate Spira API call
  this client doesn't make yet - mapping a List-type Spira custom field isn't usefully
  supported.

  **Verified**: 9 new checks in `scripts/verify-custom-field-import-resolution.ts`, run
  for real against the live dev database - `readSpiraField` directly, for
  `IntegerValue`/`BooleanValue` (including the falsy value `false` itself, which a naive
  truthiness check would have missed)/`DateTimeValue`/`DecimalValue`, plus a "still
  correctly returns null when truly nothing is set" negative case; and a full
  integer/boolean/date field end-to-end through resolution, create, validation, and
  read-back, confirming a full Spira datetime value lands as just its date portion.
  `bun run typecheck` clean, full Docker rebuild clean, all 40 e2e tests still pass.

- [x] **9.23. Test case import: Spira's standard "Type" and "Status" fields weren't
  offered for mapping** — after 9.22 the user thought they'd found another custom-field
  bug ("I don't see Spira custom fields in test cases import... on the step level"), but
  running the same field-discovery call directly against their real, already-connected
  Spira project (`SpiraClient.listTestCaseFields()`/`listTestStepFields()`) showed it
  working correctly: their project genuinely has zero custom properties configured on the
  Test Case artifact type in Spira (only Requirement and Test Step do) - confirmed both by
  the discovery call returning cleanly (no `customFieldsWarning`) and by querying Spira's
  raw `custom-properties/TestCase` endpoint directly, which returned `200` with an empty
  list (and correctly `406`-rejected deliberately-wrong artifact-type-name candidates,
  proving `TestCase` is a real, recognized type Spira just has nothing configured under).
  Spira's UI shows a case's steps inline below the case, which is almost certainly why a
  Test Step-level custom field reads as "on the test case."

  That surfaced a real, separate gap once the user then pointed at Spira's built-in
  (non-custom) "Type" field: `STANDARD_TEST_CASE_FIELDS`
  (packages/integrations/spira/src/client.ts) only offered `Name` and Spira's own
  `TestCaseId` as mappable source fields - unlike `STANDARD_REQUIREMENT_FIELDS`, which
  already includes Spira's standard `RequirementTypeName`/`ImportanceName`/`StatusName`
  specifically so a team can map them onto a custom field of their own (our fixed
  verification/validation `testType` split doesn't line up with Spira's own taxonomy, so
  these are never written automatically - see `MappedTestCase.spiraTestCaseType`, shown in
  the preview only). The equivalent test-case fields, `TestCaseTypeName` and
  `TestCaseStatusName`, were simply missing from the list. Added both, so they now show up
  in the test-case import screen's custom-field mapping dropdowns exactly like
  Requirement's do.

  **Verified**: confirmed directly against the user's real Spira project (both before and
  after the fix, via a throwaway script exercising the saved connection - not committed).
  `bun run typecheck` clean, full Docker rebuild clean, all 40 e2e tests still pass.

- [x] **9.24. Bug: a mapped list custom field with unmatched/undefined options silently
  reported "unchanged" forever** — a fourth round of the same underlying pattern as
  9.21/9.22. The user mapped Spira's standard Test Case Type field onto one of their own
  list custom fields and re-ran the import, and every row reported "unchanged" with no
  explanation. Root cause, confirmed directly against the user's real tenant and Spira
  project: their list field had **zero list options defined** yet -
  `resolveCustomFieldValues` (packages/integrations/spira/src/custom-fields.ts) correctly
  has nothing to match a Spira value against in that case, resolves to `null`, and
  `setCustomFieldValues` correctly sees no change (null before, null after) - every step
  was individually correct, but nothing anywhere said *why* the value never landed, which
  reads exactly like a bug.

  Fixed by having `resolveCustomFieldValues` also report which mapped list fields had a
  real (non-empty) Spira value that didn't match any defined option, and a new
  `formatUnmatchedListNote` helper renders that into the same per-row `note` the import
  results table already shows (alongside the existing legacy-id mismatch note and, for
  test cases, the steps-changed note) - e.g. `"Environment": Spira value "Hardware"
  doesn't match any option - left blank`. Not a validation error and doesn't fail the row
  (a list field with no match resolving to "unset" is legitimate, e.g. for a genuinely new
  Spira value), just no longer silent.

  **Verified**: 4 new checks in `scripts/verify-custom-field-import-resolution.ts` -
  `resolveCustomFieldValues` reports the unmatched field name and raw value; a matching
  value produces no note; `formatUnmatchedListNote`'s exact rendered text. `bun run
  typecheck` clean, full Docker rebuild clean, all 40 e2e tests still pass.

- [x] **9.25. Import: auto-create missing list options instead of just warning about
  them** — the direct follow-up to 9.24, and exactly what the user asked for next: "can't
  you automatically add the missing values when importing?" 9.24's note told the user
  which Spira value didn't match any option, but still required hand-typing every value
  into Settings first before a re-import could actually use it - real friction for a field
  meant to mirror an existing Spira taxonomy (their Test Case Type values: Hardware,
  Virtual, Hardware Network, Virtual Automated).

  Added `getOrCreateCustomFieldListOption` (packages/core/src/custom-fields.ts) - an
  idempotent, case-insensitive get-or-create, deliberately separate from
  `createCustomFieldListOption` (which the settings UI uses and which still rejects a
  human-typed duplicate outright, since that's a real mistake worth catching there) - and
  `autoCreateMissingListOptions` (packages/integrations/spira/src/custom-fields.ts), which
  runs inside each row's own write transaction: for every list value
  `resolveCustomFieldValues` couldn't match, it creates the missing option (using Spira's
  own value text) and swaps the new id into that row's custom field values in place of the
  `null` it would otherwise have written. It also mutates the run's shared
  `optionIdByNormalizedText` map as it goes, so a value seen on an earlier row in the same
  run is reused - not recreated - by every later row with the same value, matching
  values are only created once, keeping the option list clean. `formatUnmatchedListNote`
  is replaced by `formatAutoCreatedOptionsNote`, and both `runSpiraImport`'s and
  `runSpiraTestCaseImport`'s per-row `note` now say e.g. `created new option "Hardware"
  for "Environment"` instead of "doesn't match any option - left blank".

  **Verified**: 8 new checks in `scripts/verify-custom-field-import-resolution.ts` - the
  new option id is swapped into the row's custom field values; what was created is
  reported by field name and value; the rendered note text; the option is a real row in
  `custom_field_list_options`, not just an in-memory id; a value auto-created for one row
  is reused (not recreated) by a later row in the same run via the shared map; no
  duplicate option is ever created for a value seen twice. `bun run typecheck` clean, full
  Docker rebuild clean, all 40 e2e tests still pass.

- [x] **9.26. Test case import: also import requirement trace links, surface unmapped
  requirements, and show live progress** — three related requests together: "also import
  traces between req and tc - when importing TCs - assume REQs are already created. After
  import show REQs that couldn't be mapped. Also, show progress while importing (x/n
  processed or something)".

  **Trace links.** Confirmed directly against the user's real Spira project (no public
  Inflectra docs consulted - found by probing candidate paths against real data, same
  method as backlog item 9.18's entity-id discovery): `GET /projects/{id}/test-cases/
  {tc_id}/requirements` returns every requirement a test case is linked to in Spira. Added
  `SpiraClient.listTestCaseRequirementLinks` for it. New module
  `packages/integrations/spira/src/requirement-links.ts`: `loadImportedRequirementIdMap`
  loads every requirement this tenant has already imported (once per run, not per row -
  same idiom as `loadCustomFieldMappingResolution`), backed by a new generic
  `listEntityIdsBySource` in `packages/core/src/external-links.ts`; `resolveRequirementLinks`
  is the pure per-row matcher. `createOrUpdateTestCaseFromImport` gained a `requirementIds`
  param and a new `packages/core/src/test-cases.ts` function,
  `addTestCaseRequirementLinks` - **additive only, never removes a link**, the same
  "don't delete something nobody asked to remove" policy already applied to steps: a link
  added by hand in this system, or by an earlier import, survives even if the current
  Spira payload doesn't mention it. A link-only change now correctly reports "updated",
  not "unchanged" (same fix shape as 9.21).

  **Unmapped requirements.** "Assume REQs are already created" means this only ever
  *links*, never creates, a requirement - `resolveRequirementLinks` reports every Spira
  requirement id a test case is linked to that hasn't been imported here yet. Each row's
  `note` says how many and lists them; the test-case import screen also shows a standing
  amber summary box with every such id seen across the whole run, deduplicated, so a team
  knows to import requirements first (or knowingly accept the gap) rather than links
  silently going missing.

  **Progress.** The import mutations (`run`/`runTestCases`) gained an optional `maxRows`
  input so the screen can call them repeatedly with a small chunk size instead of one
  long blocking request. That exposed a real pre-existing bug worth fixing regardless:
  the internal page-fetch loop only checked `results.length < maxRows` *between* full
  100-row Spira pages, so a small `maxRows` didn't actually bound how many rows one call
  processed - fixed by capping each page request to `min(SPIRA_IMPORT_PAGE_SIZE, maxRows -
  results.length)`. New `SpiraClient.countRequirements`/`countTestCases` (paginating the
  same way a real run would, capped the same way) back two new count queries so the
  screen can show an honest "x/n" denominator before starting. A shared
  `useChunkedSpiraImport` hook (`apps/web/src/components/spira-import-shared.tsx`) drives
  both import screens: calls the mutation in `SPIRA_IMPORT_CHUNK_SIZE` (20)-row chunks,
  accumulating results and updating "x/n processed" between calls. The legacy-id
  (ordered) import mode is deliberately excluded from chunking - it fetches every row up
  front and always restarts at row 1 (see `runOrderedSpiraImport`'s docstring), so it has
  no notion of "just this chunk"; that mode still runs as one call with indeterminate
  progress, same as before this change.

  **Verified**: 13 new checks in `scripts/verify-test-case-requirement-links.ts` -
  `loadImportedRequirementIdMap`/`resolveRequirementLinks` against real imported and
  never-imported requirements; a link added outside the importer survives a re-import
  that only reports a *different* set of Spira links (additive-only, confirmed by reading
  the actual link rows back); a re-import that adds one genuinely new link reports both
  the count and "updated"; the final link set is the exact union of every requirement
  ever linked, from every source. `SpiraClient.listTestCaseRequirementLinks`/
  `countRequirements`/`countTestCases` also re-verified directly against the user's real
  project (a test case with known links, one with none, and both counts matching the
  project's actual 222 requirements / 71 test cases). `bun run typecheck` clean, full
  Docker rebuild clean, all 40 e2e tests and both other Spira-import verify scripts
  (legacy-id, custom-field-resolution) still pass.

- [x] **9.27. Delete a requirement or a test case** — prompted directly by the user, right
  after they needed a hand-run SQL fix to a real tenant's requirement numbering (a
  monotonic-counter side effect of an earlier bulk delete run for them by hand, not
  through the app - see that session's discussion). No "archived"/"obsolete" status
  category exists to soft-delete into (`requirement-status.ts`'s category list is fixed
  at draft/in_review/approved/baselined), so this is a genuine hard delete, guarded the
  same way every other "can I destroy this" decision in this codebase already is (levels,
  custom field options, test environments):

  - **A requirement can only be deleted while still Draft**, and only while no test case
    currently covers it (direct or via a step link) - matches the Spira importer's
    existing refusal to touch a non-Draft requirement, and the same "in use, unlink
    first" rule already used for levels/custom field options. `approval_events` is
    untouched either way (its `entityId` isn't foreign-keyed to `requirements.id`,
    deliberately, like `audit_log` - see below).
  - **A test case can only be deleted while it has no execution history at all** - the
    same principle already applied to deleting a single *step* within an existing test
    case (`test_step_executions.test_step_id` "has no cascading delete... historical
    evidence must stay resolvable"), extended to the whole test case, since
    `test_executions.test_case_id` *is* a real cascading FK and would otherwise silently
    let the database wipe out real execution evidence.
  - `external_links` and `custom_field_values` are deliberately polymorphic (not
    foreign-keyed to any one entity table), so cascading deletes don't clean them up -
    both `deleteRequirement`/`deleteTestCase` (packages/core/src/requirements.ts,
    test-cases.ts) delete the matching rows explicitly. Skipping that would leave a
    dangling `external_links` row that made a future re-import of the same Spira id crash
    looking up an entity that no longer exists.
  - `audit_log` is the one thing left alone on purpose - also polymorphic/not
    foreign-keyed, so a `"requirement.deleted"`/`"test_case.deleted"` entry (with the
    item's display id and title captured, since neither is look-up-able afterward)
    becomes exactly the immutable record PRODUCT.md's "Audit Log - immutable record of
    every state change" describes, surviving the delete it's about.
  - UI: a Delete button on each entity's own detail page (`requirements/[id]`,
    `test-cases/[id]`), with a plain `confirm()` dialog naming the item, matching this
    codebase's existing delete-confirmation convention (same as custom field deletion in
    Settings) rather than a new dialog component. Deliberately not added to the list
    views - deleting stays a deliberate, one-item-at-a-time action on the item's own page.

  **Verified**: 7 new e2e tests (`tests/e2e.test.ts`, real HTTP requests against the
  running app, same as every other feature test in this file - this is fully reachable
  over HTTP, unlike the Spira-import features, so no separate verify script) - a Draft
  requirement with nothing covering it deletes and 404s afterward; a non-Draft
  requirement is refused; a covered requirement is refused until the covering test case
  is deleted, then succeeds; deleting writes the audit entry and cleans up a simulated
  `external_links` row (confirmed by direct SQL); an unexecuted test case deletes and
  404s afterward; an executed one is refused; cross-tenant delete attempts on both fail
  under RLS. Found and worked around one pre-existing, unrelated issue while writing
  these: `audit_log.payload` (and every other audit payload in this app) is stored
  double-JSON-encoded by `writeAuditLog` - harmless so far since nothing reads `payload`
  back anywhere yet, but worth fixing before anything (an audit-log viewer, the
  monetization roadmap's audit-log export) ever tries to. `bun run typecheck` clean, full
  Docker rebuild clean, all 47 e2e tests pass.

- [x] **9.28. Deleting the tip reclaims its sequence number** — the user's immediate
  follow-up after 9.27 shipped: "when deleting the tip, maybe decrement the ID counter?".
  A direct fix for the exact gap-behind-a-delete problem their earlier hand-run
  renumbering had to work around, but scoped narrowly and safely: new
  `decrementSequenceCounterIfTip` (packages/core/src/level-sequences.ts) only ever gives a
  number back when the item being deleted is *still the highest one ever handed out* for
  its (product, level) at the moment of deletion - one atomic, conditional `UPDATE ...
  WHERE last_number = <the number being deleted> RETURNING last_number`, not a
  read-then-write, so a concurrent create that's already claimed the next number simply
  makes the `WHERE` match nothing (confirmed empirically: this driver's `db.execute`
  exposes no row-count metadata for a plain UPDATE, so `RETURNING` is what actually tells
  the caller whether it matched - same reason `nextSequenceNumber` already uses it).
  Deleting anything that *isn't* the tip still leaves the same permanent gap as before -
  deliberately not a general renumbering/compaction feature, just "undo handing out this
  one number", exactly what was asked. Wired into both `deleteRequirement` and
  `deleteTestCase`, right after the row itself is deleted; the outcome
  (`numberReclaimed: true/false`) is captured into the same `"*.deleted"` audit entry for
  transparency.

  **Verified**: 4 new e2e tests in `tests/e2e.test.ts` - deleting the tip reclaims its
  number for the very next create; deleting a non-tip item (something newer already
  exists) leaves a permanent gap, confirmed unreclaimed; two consecutive tip deletes walk
  the counter back correctly, one step at a time; the same reclaim behavior confirmed for
  test cases. `bun run typecheck` clean, full Docker rebuild clean, all 51 e2e tests pass,
  plus the other sequence-counter-touching verify scripts (legacy-id import,
  test-case-requirement-links) re-run clean to confirm no regression.

- [x] **9.29. Templated PDF document generation** — user-definable HTML+Handlebars
  templates, generating a PDF per test case, per test execution, or per a currently-shown
  list of requirements, with tenant-defined fill-in-at-export-time parameters. Nothing
  generated is ever stored - downloaded once, gone.

  **PDF engine: wkhtmltopdf, chosen over a headless browser** after the user pushed back
  on Puppeteer/Playwright ("I would hate the headless chrome, it's slow and flaky") and
  named the C#/.NET equivalent (DinkToPdf) they'd used successfully - wkhtmltopdf is
  literally the binary that wraps. A one-shot CLI conversion (HTML in, PDF out), not a
  browser automation session - none of a headless browser's failure modes (page-load
  races, zombie processes), and a much smaller Docker image addition (~80-100MB vs.
  300-400MB+ for a bundled Chromium). Not in Debian's own apt repos (dropped in recent
  releases) - installed from the official `wkhtmltopdf/packaging` release build instead,
  confirmed by actually installing it into and converting real HTML inside the exact base
  image (`oven/bun:1`, Debian trixie) before committing to it.

  **New package `packages/documents`**: `renderTemplate` (Handlebars compile+render, pure)
  and `renderPdf` (shells out to wkhtmltopdf). Two real bugs found and fixed the hard way,
  by actually running generation locally rather than trusting it would work because it
  worked in a clean container:
  - Piping HTML via stdin/stdout (`wkhtmltopdf - -`) failed under Bun's subprocess piping
    specifically (`QPainter::begin(): Returned false`) while the identical conversion via
    two temp files succeeded immediately - switched to file-based I/O, which is also the
    long-established, most battle-tested way production wkhtmltopdf wrappers in every
    other ecosystem already do this (PHP's snappy, most Node wrappers, .NET's DinkToPdf).
  - Run against a real desktop session (DISPLAY/WAYLAND_DISPLAY/several QT_* variables
    all inherited, as any developer's own machine has), wkhtmltopdf's "patched Qt" tried
    to use that real display and failed the same way - invisible in a clean Docker
    container with nothing display-related to inherit, but real anywhere else. Fixed by
    spawning with a minimal, explicit allow-list environment (`PATH`/`HOME`/locale only),
    not `{...process.env}` - which is also better hygiene regardless of the bug, since
    this process's own environment (`DATABASE_URL` and friends) has no business reaching
    an external binary fed arbitrary template-rendered HTML.

  **Schema**: `document_templates` (scope, name, html_template) and
  `document_template_parameters` (key - the `{{params.<key>}}` identifier, separate from
  the human-readable `label` shown on the fill-in form - type, required, sort order),
  both RLS-isolated, migrations 0013/011.

  **Core**: `document-templates.ts` (CRUD, mirroring custom-fields.ts's shape) and
  `document-context.ts` (builds the Handlebars context per scope - `buildTestCaseDocumentContext`,
  `buildTestExecutionDocumentContext`, `buildRequirementListDocumentContext`). The
  requirement-list scope takes an explicit `requirementIds: string[]` rather than
  re-deriving "everything in this level" server-side - it exports *exactly* what a
  requirements list is currently showing (whatever filters are active client-side), the
  same list already computed for the table, not a second server-side filter
  implementation to keep in sync with the first.

  **Generation is a raw route, not tRPC**: `POST /api/documents/generate` returns a binary
  PDF (`Content-Type: application/pdf`, `Content-Disposition: attachment`), the same
  reasoning as `/api/attachments/*` already established. Evidence (uploaded files on a
  step execution) is listed by filename only in the test-execution context, not embedded
  as images - a deliberate scope cut, easy to add later without changing anything else.

  **UI**: new `/settings/document-templates` page (per-scope template list, inline HTML
  editor with a static placeholder-reference block per scope, parameter management - same
  structural shape as `/settings/custom-fields`) plus a shared `GenerateDocumentButton`
  component wired into the test case page, the test execution page, and the requirements
  list (using its already-filtered row set) - renders nothing at all when a tenant hasn't
  defined any template for that scope yet.

  **Verified**: 7 new e2e tests in `tests/e2e.test.ts` (fully HTTP-reachable, unlike the
  Spira-import features - no separate verify script needed) - all three scopes generate a
  real PDF (checked for the `%PDF-` magic bytes, not just a 200 status) against the
  actual rebuilt Docker image's real wkhtmltopdf install; a missing required parameter is
  refused with a clear message naming it; a requirement list with a nonexistent id is
  refused rather than silently generating a partial document; template CRUD including
  cascade-delete of its parameters; a duplicate parameter key is rejected; cross-tenant
  generation is refused under RLS; generating without a session is 401. Also verified
  directly, outside the test suite: `wkhtmltopdf --version` and a real conversion inside
  the actual running container (`docker exec`), and that the client-side JS bundle sizes
  didn't grow from pulling `@galm/documents` (Bun-only APIs) anywhere near a client
  component. `bun run typecheck` clean, full Docker rebuild clean, all 58 e2e tests pass.

- [x] **9.30. Live template preview** — the user's immediate follow-up: a rendered
  preview to the right of the HTML editor, updating as the template is edited, against a
  real example entity (a test case, an execution, or a product/level's requirements) the
  user picks. Deliberately HTML-only, not a real PDF-per-keystroke: wkhtmltopdf is a real
  subprocess per call, fine for one deliberate "Generate" click but far too slow/wasteful
  to run on every keystroke - the preview renders the Handlebars template only
  (`renderTemplate`), wrapped in the same default-document skeleton `renderPdf` applies
  (`ensureHtmlDocument`, now exported from `@galm/documents` for this), so a
  body-fragment template previews with the same default styling the real PDF would get.
  Debounced ~500ms, shown in a sandboxed `<iframe srcDoc=...>` so the template's own CSS
  can't leak into the settings page.

  New `documentTemplates.previewHtml` tRPC mutation: takes the template's id (for its
  already-saved parameters) plus the *current, possibly-unsaved* editor draft as an
  explicit override, so the preview reflects what's on screen right now, not the
  last-saved copy - and, unlike the real generate route, a missing required parameter
  doesn't fail the whole preview, it just renders empty, so a half-filled-in preview
  still shows something rather than blocking on the first field typed into. Two new
  lightweight listing queries (`listExampleTestCases`/`listExampleExecutions`, capped at
  30, newest-first) back the example picker for those two scopes - no existing query
  lists across every product, since every other list in this app is scoped to one
  product/level. The requirement-list scope reuses the already-existing product/level
  pickers and `requirements.listByProduct`, capped to the first 5 requirements client-side
  so the preview stays a representative sample, not the whole level.

  **Verified**: 6 new e2e tests in `tests/e2e.test.ts` - no example selected returns no
  html and no error (not a hard failure); the preview reflects the current draft HTML,
  not the last-saved template, and is wrapped in a full document skeleton; a filled-in
  parameter substitutes correctly while an unfilled required one renders blank rather
  than erroring; all three scopes render real content from a real example; the two new
  example-listing queries return real rows; cross-tenant isolation confirmed under RLS.
  `bun run typecheck` clean, full Docker rebuild clean, all 64 e2e tests pass.

  **Follow-up: a Legend and a Handlebars reference link** — prompted by the user asking
  "what's the templating language? how do I output rendered HTML" directly in
  conversation, which is exactly the question the settings page should have already
  answered on its own. The old single paragraph explaining escaped vs. raw output was
  replaced with a standing Legend table (syntax → meaning, for `{{value}}`,
  `{{{value}}}`, `{{#each}}`, `{{this.field}}`, `{{params.key}}`) plus a direct link to
  Handlebars' own expressions reference. The per-scope placeholder list was restructured
  from a single opaque text blob into a table with an explicit `HTML` badge next to every
  field that's already-sanitized rich text (a description, a step, a background) - naming
  exactly which fields need the triple-stash form, rather than leaving that to be
  inferred from field names alone. No logic changed - UI/documentation only, so no new
  tests; all 64 e2e tests still pass, `bun run typecheck` and a full Docker rebuild both
  clean.

- [x] **9.31. Templates specify their own filename format** — the user asked for this
  directly, and it landed at exactly the right moment: without it, bulk generation
  (9.32, next) would have had every file in a zip sharing one static name (the
  template's own `name`). New nullable `document_templates.filename_template` column -
  also Handlebars, rendered against the same context as the body, but with escaping off
  (`renderFilename` in `@galm/documents` - a filename isn't HTML, a literal `&` in a
  title has no business becoming `&amp;`) and the result run through a filesystem-safety
  pass (`\ / : * ? " < > |` and control characters stripped, whitespace collapsed,
  capped at 150 characters). Falls back to the template's own `name` if unset (nullable,
  no backfill needed) or if rendering fails for any reason (a typo'd placeholder
  shouldn't block generation entirely). New templates are seeded with a sensible
  per-scope default (e.g. `{{displayId}} - {{title}}` for test cases) rather than
  needing the operator to discover the field first. The live preview (9.30) shows the
  rendered example filename alongside the rendered HTML, kept in sync with the same
  debounce.

  **Verified**: 3 new e2e tests - the filename is rendered and sanitized into
  `Content-Disposition`; an unset filename template falls back to the template's own
  name; `updateFilename` sets and clears it. `bun run typecheck` clean, full Docker
  rebuild clean.

- [x] **9.32. Bulk generation: select several test cases/executions, download one zip**
  — "select a bunch of test cases/executions and create separate reports for all of
  them... download in one zip". New `POST /api/documents/generate-bulk`, the sibling of
  the single-document route (`apps/web/src/server/document-generation.ts` factors out
  the per-target work - build context, render, convert to PDF, name the file - so the two
  routes can't quietly drift apart on what a scope needs). One PDF per selected id,
  zipped by a new `zipFiles` helper (`@galm/documents`, backed by `jszip` - a pure-JS
  library, not another external binary like wkhtmltopdf: writing a well-defined
  container format needs no rendering engine, so a plain library is genuinely simpler
  here, not a corner cut). Only `test_case`/`test_execution` scopes apply - a
  `requirement_list` template already produces one combined document for a whole list in
  a single call to the non-bulk route, so "bulk" doesn't mean the same thing there.

  Continues past a single target's failure rather than aborting the whole batch (the
  same "don't let one bad row take down the rest" principle as every importer in this
  codebase) - failures are collected into an `errors.txt` entry inside the zip instead of
  vanishing silently; only if *every* target fails does the route return a plain JSON
  error instead of an empty zip. Duplicate filenames across the batch (two targets whose
  filename template renders the same text) are disambiguated by `zipFiles` itself
  (" (2)", " (3)", ...) rather than one silently overwriting another inside the archive.
  A parameter (e.g. "Prepared by") is filled in once for the whole batch, not once per
  file - the realistic case. A sanity cap (100 targets per request) refuses an
  accidentally-huge selection before any generation work starts.

  **UI**: checkboxes added to the test cases list (`test-cases-section.tsx`, a "select
  all visible" header checkbox + per-row) and to a test case's own execution history list
  - both independent of whatever filters are active, matching how the existing
  requirement-list "whatever's currently shown" generation already works with filters. A
  new `BulkGenerateDocumentButton` (template picker + parameter inputs + one "Download N
  reports (zip)" button) appears only once something is actually selected.

  **Verified**: 8 new e2e tests, including a hand-rolled zip-local-file-header parser in
  the test file itself (reads real entry filenames directly out of the actual zip bytes
  the server returned - no need for a zip-parsing library in `tests/`, since a filename is
  stored uncompressed in its entry's header regardless of compression method) - bulk
  generation for test cases and for executions each produce one correctly, distinctly
  named entry per target; two targets whose filename template collides get disambiguated
  inside the same zip; a partially-failing batch still returns the successes plus
  `errors.txt`; an entirely-failing batch returns a JSON error, not an empty zip; the
  wrong id array for a template's scope, a `requirement_list` template, and exceeding the
  100-target cap are all refused with clear messages; a cross-tenant target is refused
  under RLS as a per-item failure. `bun run typecheck` clean, full Docker rebuild clean,
  all 75 e2e tests pass.

  **Follow-up: export form moved into a modal, and made wizard-y (9.33)** — direct user
  feedback right after 9.32 shipped: keep the selection checkboxes exactly as they are
  ("we'll use it for other features"), but the always-visible inline export form
  (template picker + parameter fields + generate button, all shown at once whenever
  something was selected/on every test case or execution page) was cluttering pages for
  what's an infrequently-used feature - and the flow itself should be a wizard: pick a
  template first, *then* see its fields. Both `GenerateDocumentButton` and
  `BulkGenerateDocumentButton` are now just a trigger button (invisible entirely if no
  template exists for that scope, same as before) that opens a small modal
  (`@/components/ui/dialog`, the same Base-UI-backed component `EsignModal` already
  uses). The actual two-step logic (choose a template, unless there's only one - then
  skip straight to its fields; fill in parameters; generate) is a new shared
  `DocumentGenerationWizard`, used by both buttons so the flow can't drift between the
  single-document and bulk-zip cases. Purely a client-side UI change - no API or
  rendering logic touched, so no new tests; all 75 e2e tests still pass, `bun run
  typecheck` and a full Docker rebuild both clean.

- [x] **9.34. "Export documents" wording, and real progress for bulk exports** — two
  pieces of direct user feedback: rename "generate reports" language to "export
  documents" throughout, and add a progress indicator for bulk generation since it can
  take a while. Real progress, not a simulated/timed progress bar: `/api/documents/
  generate-bulk` now streams newline-delimited JSON as it works - one `{"type":
  "progress", done, total}` line per completed target, then a final `{"type":"done",
  filename, zipBase64}` (the zip base64-encoded *inside* that last JSON line, not raw
  bytes after a text/binary boundary - a deliberate ~33% size tradeoff in exchange for
  every line staying valid JSON, no binary-framing edge cases to get wrong) or
  `{"type":"error", message}` if every target failed. One real architectural
  consequence: once the stream has started (HTTP 200 already sent), an "every target
  failed" outcome can no longer become a 4xx status - it's the in-stream error line
  instead. Validation decided *before* any generation starts (bad templateId, wrong
  scope, too many targets, wrong id array for the scope) is unaffected and still a
  normal non-200 JSON response, since nothing has streamed yet at that point. Also
  switched from one `withTenant` transaction for the whole batch to one per target
  inside the streaming loop - the identical reasoning already documented for
  `runSpiraImport` (lock contention; Postgres aborting a whole transaction after one
  failed statement inside it) applies just as much here and wasn't quite right before.

  `DocumentGenerationWizard` grew a `streaming` mode: reads the response body with a
  manual `getReader()` loop (not `res.json()`/`res.blob()` - the point is reacting to
  each line *as it arrives*, not after the connection closes), showing a `<progress>`
  bar and "Exporting N of M..." as events arrive, then decodes and downloads the final
  zip. The single-document route/button (`GenerateDocumentButton`) is untouched - one
  request has no meaningful discrete steps to report progress on, "Exporting..." (the
  existing spinner text) already says what's happening.

  **Verified**: 3 of the existing bulk e2e tests (BACKLOG.md 9.32) updated for the new
  response shape rather than left passing against stale assumptions - a successful bulk
  run now asserts on the actual sequence of progress events received (`[{done:1,
  total:2}, {done:2,total:2}]`), not just the final zip; the all-targets-failed case
  asserts the target still counted as "done" in a progress event before the final error
  line, confirming the progress bar reaches the end rather than hanging; cross-tenant
  and partial-failure cases re-verified against the new `zipBytes`/`progressEvents`
  shape. `bun run typecheck` clean, full Docker rebuild clean, all 75 e2e tests pass.

- [x] **9.35. Block switching templates mid-export; confirm-then-cancel on close/leave**
  — "Block 'Choose a different template' while is exporting. Closing modal or leaving
  page should cancel, but asking for confirmation first (if it's by mistake)". Three
  parts:
  - The "← Choose a different template" button (and the parameter inputs) are now
    `disabled` while `isGenerating` - the in-flight request is for the currently-selected
    template; letting the operator pick a different one out from under it would leave the
    export running against a choice no longer shown on screen.
  - `DocumentGenerationWizard` gained a real `AbortController`, wired into the `fetch`
    call (both the plain and streaming paths) via `signal`, and an imperative
    `cancel()` exposed through `forwardRef`/`useImperativeHandle` so a caller that
    doesn't otherwise touch its internals can still interrupt an export in flight.
  - New shared `useExportDialogGuard` hook (co-located with the wizard, used by both
    `GenerateDocumentButton` and `BulkGenerateDocumentButton`): closing the dialog while
    generating (Escape, the X button, clicking outside) is intercepted via the `Dialog`'s
    own `onOpenChange` - a plain `confirm()` asks first, and only calls `cancel()` (then
    lets the dialog actually close) if confirmed; declining leaves the dialog open and the
    export running untouched. Leaving the page entirely reuses the existing
    `useUnsavedChangesGuard` hook wholesale (backlog item 9.10 or wherever it was first
    built) - an export in progress is treated exactly like an unsaved form: a native
    "leave site?" prompt on tab close/refresh, a `confirm()` gate on in-app link clicks.

  **Verified**: real, not just compiled - a one-off script (not committed) issued a real
  `fetch` with an `AbortController` against the actual running bulk-export endpoint and
  called `.abort()` shortly after starting; the fetch genuinely rejected with
  `AbortError` (~53ms, matching the abort timing), confirming the cancellation mechanism
  this feature relies on actually tears down the request, not just that the code
  compiles. One honest gap: this project's e2e suite is HTTP-only (no headless browser),
  so the *interactive* dialog-dismissal wiring (Escape/backdrop-click routing through
  `onOpenChange`, the `confirm()` prompt itself appearing) relies on Base UI's documented
  contract for its `Dialog` primitive rather than being independently re-verified in a
  real browser here. `bun run typecheck` clean, full Docker rebuild clean, all 75 e2e
  tests pass (unchanged - this was a client-side-only change with no server behavior to
  regress).

- [x] **9.36. Fix: a *successful* export wrongly showed "are you sure" and skipped the
  download** — bug report right after 9.35 shipped: "now when export is done it shows
  this 'are you sure' message and doesn't download (if I cancel)". Root cause was not in
  the new 9.35 code at all - it was `useUnsavedChangesGuard`'s existing document-level
  click listener (reused wholesale by `useExportDialogGuard` for the "leaving the page
  mid-export" case) firing on the wrong click. The wizard downloads a finished export by
  creating a temporary `<a href="blob:..." download>`, appending it to the DOM, and
  calling `.click()` on it to trigger a save - but at that exact moment `isGenerating` is
  still `true` (it's cleared right after), and the guard's click handler treats *any*
  clicked anchor with an `href` as an outbound in-app link, popping its own "leaving this
  page will cancel it" confirm before the browser ever processes the anchor's actual
  default action. Declining that spurious prompt calls `preventDefault()`, which cancels
  the browser's native download too - matching exactly what was reported.
  - Real fix: `useUnsavedChangesGuard`'s click handler now exempts any anchor with a
    `download` attribute - a download never navigates the page away, so it was never a
    "leaving" event to guard in the first place. One line, fixes it for every current and
    future caller of this shared hook, not just the document-export wizard.
  - Also applied while investigating (defense-in-depth, not the actual cause, but real
    correctness improvements found along the way): `generate()` now clears
    `isGenerating`/`abortControllerRef`/`progress` *before* calling `onGenerated()`
    rather than after, so a caller's own `onGenerated` (which typically closes the dialog)
    never sees a stale "still generating" flag; and `useExportDialogGuard`'s
    `confirmClose` now reads a `useRef`-backed value rather than the `isGenerating` state
    closure, since a synchronous `onOpenChange` can fire before React commits a state
    update.

  **Verified for real, in a real browser** - this is an interactive DOM-timing bug the
  project's HTTP-only e2e suite structurally cannot observe, so `playwright` (headless
  Chromium, matching the version already cached on this machine) was used for one-off,
  not-committed scripts against the actual rebuilt Docker stack: (1) registered a tenant,
  created a template and test case via the real API, drove a real browser through the
  export dialog, clicked Export, and confirmed via `page.on('dialog', ...)` and
  `page.waitForEvent('download')` that the file now genuinely downloads with **zero**
  unwanted native prompts and the dialog closes cleanly - this reproduced the exact
  reported bug before the fix (same confirm text, download blocked) and passed clean
  after it; (2) a second script delayed the export response and pressed Escape mid-export
  to confirm the *legitimate* "cancel this export?" prompt (a different, correctly-still-
  working confirmation from 9.35) still appears and still works, so the fix didn't
  overcorrect and silently swallow that one. `bun run typecheck` clean, full Docker
  rebuild, all 75 e2e tests pass (unchanged - no server-side behavior changed).

- [x] **9.37. AI-assisted test step drafting** — "add some LLM-assisted features, e.g.
  help writing test steps... specific workflow: 1. user tells agent what to do... 2. the
  agent proposes changes 3. user can refine or accept." A chat-style "Draft with AI"
  button on the Steps section of both test-case pages: type an instruction, the model
  proposes a step list shown as a color-coded diff against what's in the editor, and you
  refine (same conversation) or accept (replaces the editor's step list - nothing
  persists until the page's own Save).
  - **Provider-agnostic, no Vercel account**: the open-source Vercel AI SDK (`ai` +
    `@ai-sdk/anthropic`/`openai`/`openai-compatible`) resolves a tenant's saved
    connection to an explicit provider instance and calls that provider's own API
    directly with the tenant's own key - "OpenAI-compatible" covers self-hosted (Ollama,
    vLLM) or third-party (Groq, Together, DeepSeek) endpoints via a custom base URL.
    `generateObject` with a Zod schema, not prose-parsing.
  - **Credentials**: new per-tenant `llm_connections` table (Settings → AI connection),
    mirroring `spira_connections` exactly (key never echoed back, empty key on re-save
    keeps the existing one, plaintext storage - same documented trust boundary as every
    other credential here).
  - **New package** `packages/integrations/llm`: `resolveModel`, the step-suggestion
    schema/prompt builder, `proposeStepChanges`/`pingModel`. No `@galm/db` dependency and
    never imported client-side - `step-diff.ts` declares its own small matching
    `ProposedStep` type instead, same duplicate-the-shape convention as `@galm/documents`.
  - The diff is computed **client-side from real content comparison** (by client-
    generated step `key`), never trusted from what the model claims about its own edit.
    Baseline is fixed for the whole dialog session.
  - **Security gap found and fixed while building this**: an unaccepted proposal renders
    directly via `RichTextView`, which assumes safe input - but the model's HTML never
    passes through the app's sanitize-on-write path until accepted. Fixed by sanitizing
    every proposed step server-side, inside `suggestSteps`, before the response reaches
    the browser.
  - `suggestSteps` never writes to `test_steps` - verified directly against Postgres,
    not just by reading the code.
  - **No real LLM calls in tests**: `resolveModel` has a doubly-gated escape hatch
    (sentinel `baseUrl` + `ALLOW_MOCK_LLM_PROVIDER=1`, dev/CI only) returning a fake
    `ai/test` model that parses the real baseline step's key back out of its own prompt,
    so tests exercise a genuine "unchanged" row, not just "added". Invisible to the
    production surface - no `"mock"` provider value in the DB CHECK or settings UI.

  **Verified**: `bun run typecheck` clean across all packages; full Docker rebuild;
  migration applied and confirmed via `\d llm_connections` against the live container;
  e2e suite (81 tests, 6 new) covers no-connection-yet, key never echoed/kept on empty
  re-save, `testConnection` against the mock, a well-shaped proposal writing nothing to
  `test_steps`, a mock failure returning `{error}` not a 500, and cross-tenant RLS. A
  real-browser Playwright script (one-off) drove the actual UI: opened the dialog,
  submitted an instruction, confirmed the diff, accepted, saved, and confirmed via a
  follow-up API call both steps persisted. Whether a *real* provider's suggestions are
  good isn't something automation can assert.

- [x] **9.38. Fix: the AI-assist result modal overflowed the window with no way to
  scroll** — "the result modal overflows the window, doesn't scroll - I can't see
  anything :D". Root cause wasn't specific to this dialog: the shared `DialogContent`
  primitive had no height cap or scroll handling at all - every other dialog just never
  had enough content to expose it.
  - Fixed once at the shared component: content now scrolls in its own `flex-1 min-h-0
    overflow-y-auto` box, a sibling of the close button (which stays pinned in the
    corner). A first attempt (`grid` + `overflow-hidden` on the outer popup) looked
    right, but a real-browser check showed nothing was actually scrollable -
    `min-height: auto` let the inner box grow past its track instead of being
    constrained. Caught by measuring `scrollHeight`/`clientHeight` for real, not by
    reading the CSS.

  **Verified**: a real headless-browser script (Playwright, one-off) confirmed against a
  genuinely overflow-prone case: the content box has real scroll height, the dialog
  itself never exceeds the viewport, scrolling moves `scrollTop`, and the close button
  stays visible. A second script confirmed a normal short dialog is unaffected. `bun run
  typecheck` clean, full Docker rebuild, all 81 e2e tests pass.

- [x] **9.39. AI tools moved from a modal to a collapsible side panel, with a real
  before/after diff** — "I'd like the diff view to show before-after. Maybe a
  collapsible 'AI tools' side-panel would be better?" Agreed: a real before/after and an
  ongoing chat both want more room than a small modal, and a modal hides the page you're
  comparing against. `TestStepAssistButton`'s modal replaced by `AiToolsPanel`, a
  collapsed-by-default `<aside>` next to the Steps editor, `sticky` so it tracks
  scrolling with the page.
  - A `modified` row now renders two columns (Before struck-through / After);
    `added`/`removed`/`unchanged` stay single-column. New mock branch
    `__mock_modify_step__` echoes a real step's key with different content so this is
    exercised for real, not with an invented key.
  - Collapsing is a CSS `hidden` toggle on the body, not an unmount - the chat/proposal
    state lives in the always-mounted parent, so collapsing mid-conversation loses
    nothing.
  - Both test-case pages widened (`max-w-6xl`) and restructured into a flex row (form
    flex-1, panel a fixed-width sibling); sections that don't need the width stay at
    their original `max-w-4xl`.

  **Verified**: a Playwright script (one-off) confirmed the panel starts collapsed with
  the step editor still visible underneath (not a modal covering the page), the modify
  branch renders real Before/After content, and accepting updates the real editor
  without closing anything. A new e2e test covers the modify branch at the HTTP layer.
  `bun run typecheck` clean, full Docker rebuild, all 82 e2e tests pass.

- [x] **9.40. AI tools panel: overlay instead of in-flow, resizable, and its state
  persists** — "I'd prefer a collapsible panel on top of contents... user can decide how
  wide it is." Follow-up to 9.39: that panel was still in the page's own layout flow,
  widening both test-case pages. `AiToolsPanel` is now `position: fixed` to the right
  edge, floating on top of the page - it never resizes or reflows, and both pages went
  back to their original widths.
  - Collapsed state is a small fixed tab at the right edge; expanding doesn't change
    anything else on the page.
  - User-resizable via a pointer-driven drag handle (not HTML5 drag-and-drop), clamped
    320-800px.
  - Open/closed and width persist per-device via `localStorage` (`ai-panel-prefs.ts`),
    matching `last-location.ts`'s try/catch-wrapped convention.
  - `z-[41]` - above the edit page's Save/Discard bar (`z-40`), below the `z-50`
    dialogs/dropdowns used everywhere else.

  **Verified**: a Playwright script confirmed `<main>`'s measured width is identical
  before/after expanding (the page genuinely doesn't reflow), the resize handle grows
  the panel by the dragged amount, and both open state and width survive a real page
  reload. `bun run typecheck` clean, full Docker rebuild, all 82 e2e tests pass
  (client-side layout change only, no server behavior changed).

- [x] **9.41. Fix: real steps were showing as "modified" in the diff when nothing had
  actually changed** — "the diff shows some steps as modified, when they haven't changed
  at all." Root cause: `diffProposedSteps` compares HTML strings, and a model asked to
  "copy this step verbatim" never reproduces the exact bytes - it re-encodes `&`, writes
  `<br/>` for `<br>`, straightens quotes, rewraps whitespace. None of that is a real
  change.
  - `normalizeHtml` now also decodes common entities, treats `<br>`/`<br/>`/`<hr>`/
    `<img>` variants as the same tag, straightens curly quotes, and trims whitespace
    just inside the outermost tag - on top of the existing between-tags collapse.
    `purpose` gets the same whitespace normalization.
  - Deliberately still string/regex-based, not real HTML-equivalence checking (attribute
    reordering isn't handled) - targets specifically the reformatting an LLM tends to
    introduce, not every possible rewrite. Checked directly that this doesn't start
    treating real changes (a word swap, a purpose change, a requirement-link change) as
    unchanged too.

  **Verified**: an ad-hoc script ran the candidate normalizer against 11 realistic
  before/after pairs, catching a real regression in the first draft (it dropped the
  existing between-tags collapse). More durably: this is the project's first frontend
  unit test (`step-diff.test.ts`, Bun's own runner) - 16 tests covering every
  false-positive case plus the "still detects a real change" cases, not wired into
  `typecheck`/e2e (both stay HTTP/DB-focused), run directly. `bun run typecheck` clean,
  full Docker rebuild, all 82 e2e tests pass.

- [x] **9.42. AI step drafting: delta output instead of the full step list every turn**
  — "It uses a lot of tokens - would it be limited if it didn't output the full list?
  just added/modified?" `suggestSteps`'s response is now a delta - `{ summary, upserts:
  [new/changed steps], removedKeys }` - merged back into the full list client-side
  (`applyStepDelta`) for free, no LLM involved. A one-step edit on a 20-step case no
  longer means regenerating all 20.
  - Since an untouched step is now never regenerated, it can no longer pick up the
    reformatting drift that caused 9.41's false-positive "modified" bug - impossible now
    for any step the response doesn't mention, not just harder to trigger.
  - **Trade-off accepted, not hidden**: the delta contract carries no ordering signal -
    a modified step keeps its position, a new one appends at the end. Free-form
    AI-driven reordering no longer works (manual up/down still does) - judged acceptable
    since reordering was never a first-class diff feature anyway.
  - A new step gets a real key the moment it's merged in, not just at final Accept -
    needed so a refinement turn can refer back to a step this turn just added.
  - The mock's branches were made atomic (one delta operation each) instead of every
    branch also adding an unrelated step - a carryover from the old full-list design.
  - Deferred, not forgotten: prompt caching, capping resent history, on-demand
    requirement fetching instead of sending up to 300 every turn.

  **Verified**: a real two-turn Playwright conversation against a 3-step case initially
  failed its own assertion - not the app, but the mock's old "every branch also adds a
  step" habit, which is what prompted making it atomic. After the fix: turn 1 showed
  exactly 1 added + 3 unchanged; turn 2's refinement showed 1 modified with a real
  rendered diff, proving the new-step-gets-a-key mechanism holds across turns. 6 new
  unit tests, 2 new e2e tests. `bun run typecheck` clean, full Docker rebuild, all 83
  e2e tests pass, all 22 unit tests pass.

- [x] **9.43. Fix: inserted steps landed at the end instead of where asked; step numbers
  now shown in the diff** — "it added 2 steps in the middle, but they ended up at the
  end. Also make sure step number is in the diff." Direct fallout from 9.42's flagged
  trade-off: the delta contract had no way to say *where* a new step should go.
  - `stepSuggestionResultSchema` gained an optional `order`: the complete final key
    sequence, with a `null` placeholder per new step. Omitted for the common case (pure
    content edit). `applyStepDelta` honors it without trusting it blindly - an unknown
    key is skipped, a step `order` forgot about is appended at the end rather than
    dropped.
  - `diffProposedSteps` now computes `position`/`originalPosition` per row. The panel
    shows "Step N", "Was step N" for removed rows, and "Step N (was M)" whenever a kept
    step's position shifted - visible even when its content didn't change.

  **Verified**: unit tests cover `order` handling (placement, reordering, unknown keys,
  forgotten steps, interaction with `removedKeys`) and the new position fields. A new
  e2e test drives the mock's `__mock_insert_middle__` branch. A Playwright script ran
  the actual reported scenario end to end - correct step numbers in the diff, correct
  position after Accept, and confirmed via a follow-up API call that Save persisted that
  exact order. `bun run typecheck` clean, full Docker rebuild, all 84 e2e tests pass,
  all 31 unit tests pass.

- [x] **9.44. Fix: a hallucinated requirement id broke every AI request after the one
  that introduced it** — "when asking for second edit in the AI box I'm getting [...]
  Invalid uuid [...] path: originalSteps, 30, requirementIds". Nothing validated that a
  model-proposed `requirementId` was actually real; a hallucinated one flowed through
  `acceptProposal` into the editor state and from there into every subsequent request's
  `originalSteps` (which requires real uuids) - so the request that introduced it
  succeeded, but every one after it failed. Would have broken Save the same way.
  - **Server-side**: `suggestSteps` now strips any unreal `requirementId` before the
    response reaches the client, alongside the existing HTML sanitization. "Real" is the
    union of the AI's context list *and* whatever ids were already linked on the input
    steps - not the context list alone, since it's capped at 300 and an edit to an
    already-linked step outside that cap must survive.
  - **Client-side, defense-in-depth**: the same filter (`filterKnownRequirementIds`) is
    applied wherever a step's existing requirementIds get read back out - a step the AI
    never touches passes through every merge unmodified, so the server-side fix alone
    doesn't clean up an id already sitting in a step from before this fix existed.

  **Verified**: mock branch `__mock_hallucinate_requirement__` reproduces this without a
  real model misbehaving on cue. Two new e2e tests (stripped server-side; a real
  already-linked id is never mistaken for hallucinated - the beyond-300-cap edge case is
  an honest documented gap, too expensive to seed for e2e). Four new unit tests. A
  Playwright script reproduced the user's exact sequence: trigger the hallucination,
  accept, submit a second request - previously a Zod error, now clean. `bun run
  typecheck` clean, full Docker rebuild, all 86 e2e tests pass, all 35 unit tests pass.

- [x] **9.45. Fix: the whole app had horizontal scroll on narrow screens - unrelated to
  the AI panel work** — "my page is too wide now, I've got horizontal scroll wherever I
  am." Investigated broadly given "wherever I am" - swept scroll-overflow measurements
  across every route at several widths, with the AI panel both collapsed and expanded.
  Zero overflow anywhere the panel appears - it was never the cause. The real culprit:
  `TopBar`, rendered on every authenticated page.
  - Root cause: the breadcrumb-style left content (product switcher, level toggle,
    dropdown) had no width containment - a flex item's `min-width: auto` refuses to
    shrink below its content. On a narrow screen that content alone exceeds the
    viewport, growing the whole page and pushing the avatar/settings icons off-screen.
  - Fixed the same way as 9.38: contain it with internal scroll instead of letting it
    grow the page - `min-w-0 flex-1 overflow-x-auto` on the left content, `shrink-0` on
    the corner.

  **Verified**: Playwright scripts measured `scrollWidth` vs `clientWidth` across 14
  routes at three widths - reproduced real overflow (up to 141px) before the fix on
  several pages with no AI panel, zero overflow after. A follow-up confirmed the
  breadcrumb content (429px in 286px of space at 390px) now scrolls internally rather
  than pushing the page, with the settings icon staying on-screen. `bun run typecheck`
  clean, full Docker rebuild, all 86 e2e tests still pass.

- [x] **9.46. Fix: "horizontal scroll wherever I am" on a large screen turned out not to
  be a layout bug at all** — direct follow-up to 9.45: "something is obviously wrong
  even on a large laptop screen I get horizontal scroll and everything is spread too
  wide!"
  - Re-swept 9.45's overflow measurements across every route at 1440-1920px, panel
    collapsed/expanded/max-width/persisted-and-reloaded, long content, real SPA
    navigation - zero overflow anywhere.
  - Had the user run a live diagnostic on their own real pages checking for any element
    with real scrollable width in both directions - came back with nothing but a few
    cosmetically-negligible pixels, nowhere near enough to explain "actually moving and
    revealing real content," which ruled out my initial guess (the gray-box browser
    back/forward preview).
  - Actual cause: Chrome's own swipe-to-navigate-back/forward gesture - on some
    platforms it renders as the page sliding to reveal the real previous/next page in
    history, visually indistinguishable from a layout bug but nothing to do with this
    app's layout. This app never opted out (`overscroll-behavior-x: none` on `body`);
    many sites do, specifically to avoid this confusion. Fixed by adding it.
  - Left open, not assumed away: whether "before the AI sidebar it was fine" reflects an
    actual change or just when the user started noticing - nothing about the sidebar
    touches scroll behavior, and the missing CSS property predates it.

  **Verified**: `getComputedStyle(document.body).overscrollBehaviorX === "none"`
  confirmed on every route against the real rebuilt stack. Honestly bounded: Playwright
  can't simulate a real native trackpad gesture (it lives in the browser/OS input layer
  below the DOM), so the CSS is confirmed applied but whether it resolves the user's
  specific sensation needs their own confirmation. `bun run typecheck` clean, full
  Docker rebuild, all 86 e2e tests still pass.

- [x] **9.47. AI diff: a real git-style inline diff instead of Before/After columns** —
  "can you make the diff more git-like? Highlighting specific characters
  added/removed/changed." A "modified" row used to show the whole field twice; nothing
  pointed at what actually changed, and a one-word fix looked the same as a rewrite.
  Replaced with one inline line per field - unchanged text plain, removed struck
  through, added highlighted - the same visual language `git diff --word-diff`/GitHub
  use, at character granularity per what was asked (a typo fix highlights just the
  changed letters, not the whole word).
  - New `diff` (jsdiff) dependency, via `diffChars`. `expectedResult` and (when changed)
    `purpose` get the same treatment as `description`.
  - Diffs plain text, not raw HTML - character-diffing markup could split a segment
    across a tag boundary, unrenderable as valid HTML. New `text-diff.ts` strips
    tags/decodes entities (regex-based, not `document`-based, so it stays testable under
    Bun's DOM-less runner) before diffing - later consolidated with the pre-existing
    `version-diff.tsx` redline feature's identical stripping logic into one shared
    `htmlToPlainText`.
  - Mock branch `__mock_typo_fix__` echoes the real description with a small appended
    suffix, not a wholesale swap - without it, every mock-driven "modified" test would
    only exercise the "two completely different strings" case, not what actually proves
    the diff highlights *specifically* what changed.

  **Verified**: 12 unit tests in `text-diff.test.ts` (identical text unchanged, a word
  swap highlights only those words, a typo fix highlights fewer characters than the
  whole word with an explicit round-trip reconstruction check, entities decode before
  diffing, adjacent HTML blocks don't run together). A new e2e test drives
  `__mock_typo_fix__`. A Playwright script confirmed the old Before/After labels are
  gone, the row reads as one continuous line, and the highlighted span contains exactly
  the appended text and nothing struck through. `bun run typecheck` clean, full Docker
  rebuild, all 87 e2e tests pass, 47 unit tests pass across both diff test files.

- [x] **9.48. Pre-commit cleanup of the AI-assist work (9.37-9.47), and a real bug found
  along the way** — "get ready for commit. Cleanup useless comments, redundant code,
  excess text from documentation." Trimmed verbose inline comments across the feature's
  files, condensed this span of BACKLOG.md/TECH_STACK.md toward the project's usual
  house style, and consolidated `text-diff.ts`'s HTML-stripping with the pre-existing
  `version-diff.tsx` redline feature's own (until-now duplicate) copy into one shared,
  exported `htmlToPlainText` - fixing a real bug in the process: the new copy was
  missing a space between adjacent block elements (`<p>A</p><p>B</p>` → "AB" instead of
  "A B").
  - **Real, previously-unreported bug found while reviewing, not by a user report**:
    `AiToolsPanel` collapsed via a conditional `return` choosing between the small tab
    button and the full `<aside>` - which unmounts `AiStepAssistBody` (and its
    in-progress chat/proposal `useState`) every time the panel collapses, silently
    discarding any pending AI conversation. The component's own docstring claimed
    otherwise (a `hidden`-toggle, not an unmount) - a regression from 9.40's rewrite that
    was never re-checked against this specific claim. Fixed by keeping both branches
    mounted in a fragment, toggled via the native `hidden` attribute.
  - Also removed `StepSide`'s now-fully-unused `label` prop (dead since 9.39's
    Before/After columns were replaced by 9.47's inline diff) and a stale orphaned
    docstring left over from that same change.

  **Verified**: `bun run typecheck` clean across all packages; full Docker rebuild; all
  87 e2e tests and all 47 unit tests (35 step-diff + 12 text-diff) still pass, confirming
  the cleanup itself introduced no regression. The panel-collapse fix was additionally
  verified with a dedicated Playwright script (one-off): generated a proposal, collapsed
  the panel via its own collapse button, confirmed the `<aside>` was hidden, re-expanded
  via the "AI tools" tab, and confirmed the pending proposal and Accept button were still
  there - PASS.

- [ ] **9.49. Architecture module** — product-scoped software architecture trees (software
  items, software units, OTS) with tenant-defined levels (seeded System Architecture /
  Software Architecture; a tenant can add more, e.g. one level per software). Each
  `(product, architecture-level)` is its own containment tree; parents cannot cross
  levels. Mermaid diagram is generated from the tree and can rewrite parentage/titles of
  existing nodes (Apply / Reset); Apply does not create or delete nodes.

  **Links.** Requirements and test cases can each link to many architecture nodes
  (items / units / OTS), and each node can link to many requirements and test cases.
  Architecture Trace view lists nodes with their linked reqs/TCs; requirement and test-
  case lists expose a selectable Architecture column.

  **Explicitly not in this release** (schema comments only): SBOM generation and
  vulnerability search on OTS (supplier + version are already stored as identity);
  detailed designs on software units; versioning/approval of architecture snapshots for
  the DHF.

- [x] **9.50. OTS documentation** — per-component documentation shaped after FDA's
  *Off-The-Shelf Software Use in Medical Devices* (2023), built on 9.49's OTS nodes,
  versions and NVD scanning.

  **Decisions.**
  - No Basic/Enhanced switch: every field is optional and completeness is informational
    only. The documentation level is an optional parameter on the seeded template.
  - Structured tables, not custom fields:
    - `ots_profiles` for the section III answers;
    - `ots_platform_links` for "runs on", so platform versions come from the linked items;
    - `ots_version_assessments` for per-version change impact.
  - OTS versions gain release date, patch, upgrade designation and notes URL (immutable),
    plus a mutable support status (`in_use`/`allowed`/`retired`).
  - Known issues (`ots_anomalies`) are separate from CVEs:
    - affected versions are ticked, and none ticked means all versions;
    - "fixed in" is free text;
    - an outcome requires a rationale;
    - "Mark list reviewed" is its own audited action.
  - UI wording is guidance-neutral, for non-medical teams.
  - Out of scope: SBOM export, a risk module, linking test runs to software versions, and
    non-OTS anomalies.

  **Surface.**
  - `packages/core/src/ots.ts` and the `ots.*` router.
  - Documentation and Known issues tabs on OTS items.
  - An "OTS register" view with CSV export.
  - The `ots_list`/`ots_component` template scopes and a seeded "OTS Software
    Documentation" template (run `db:backfill-tenant-defaults` for existing tenants).

  **Verified**: typecheck clean; new unit tests (`ots.test.ts`) and e2e tests ("e2e: OTS
  documentation"); full suite passes.

- [ ] **10. Self-host packaging** — finalize `docker-compose.yml` for external users (env
  templating, first-run setup docs), confirm the three-service topology holds up outside the
  dev environment.

- [ ] **11. Hosted multi-tenant SaaS onboarding** — self-serve org signup, tenant
  provisioning, the cross-tenant-isolation automated test suite (see risk below) becomes a
  hard gate here before this ships.

## Open decisions to make before relevant items start

- **Before item 2**: which specific future-paid features named in `PRODUCT.md`'s
  monetization section (SSO/SAML, Part-11 e-signature package, audit-log export/retention)
  to consciously avoid building deeply into the open repo yet, so "fully open for now"
  doesn't quietly foreclose the monetization path already named there.
- **Before item 11**: confirm the cross-tenant RLS automated test suite is treated as a hard
  gate on hosted multi-tenant launch, not an afterthought.
