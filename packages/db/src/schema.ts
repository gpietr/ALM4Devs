import {
  type AnyPgColumn,
  boolean,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Walking-skeleton schema (backlog item 0). Deliberately minimal: just enough tables to
 * prove the RLS/multi-tenancy model, the audit-log immutability + hash chain, and a
 * better-auth-compatible auth schema all work end-to-end under Bun + Drizzle + bun-sql.
 * The real domain model (Requirement, Test Case, etc.) is backlog item 1.
 */

export const tenants = pgTable("tenants", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// --- better-auth core tables --------------------------------------------------------
// Shape matches better-auth's default Drizzle adapter expectations for email/password +
// session auth. Extended with tenantId so a signed-up user is scoped to an organization.

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  password: text("password"),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

// --- demo tenant-scoped table, used only to prove RLS isolation ---------------------

export const items = pgTable("items", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// --- Product/System, Requirement, and the customizable status model (backlog item 2) ---
//
// Statuses are deliberately NOT a hardcoded enum. Each tenant gets its own row per status
// (name, sort order, enabled/disabled) so a team can rename "Baselined" or turn it off
// entirely if their process doesn't use it. What IS fixed, in code, is a small set of
// *categories* (see packages/core/src/requirement-status.ts) the domain logic needs to
// know the behavior of - e.g. only entering the "approved" or "baselined" category
// requires an e-signature. A custom status always maps to exactly one category; the
// category is what the workflow engine reasons about, the status row is what the user
// sees and can rename. Safety classification (requirements) and test type (test cases)
// used to be a second fixed-enum concept alongside status, on the same "regulatory
// concept, not team preference" reasoning - reversed later (see custom-fields.ts's
// seedDefaultCustomFields): they're ordinary tenant-defined custom fields now, just
// pre-seeded so every tenant still gets them without configuring anything.

export const products = pgTable("products", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// Backs the sequential, per-(product, level) human-readable ids shown everywhere a
// requirement or test case appears (SYSREQ-1, SYSREQ-2, ...) - one row per (product,
// level) pair, holding the last number handed out. Shared by both requirement levels and
// test levels, which are the same physical `levels` table below (see its docstring), so
// `levelId` is a real foreign key rather than a bare uuid the two source tables merely
// happened not to collide on. Scoped per product rather than tenant-wide so two unrelated
// products under one tenant each get their own SYSREQ-1, matching how every other
// requirement/test-case list is already scoped to one product at a time. See
// packages/core's nextSequenceNumber - always incremented via a single atomic
// `insert ... on conflict do update` inside the same transaction as the item it numbers,
// never read-then-write, so concurrent creates can't race onto the same number.
export const levelSequenceCounters = pgTable(
  "level_sequence_counters",
  {
    // Included in the primary key alongside product_id (itself already tenant-scoped via
    // its own FK) so this table keys the same way every other tenant-scoped table does -
    // not because a real product_id/tenant_id ambiguity has ever been observed.
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    levelId: uuid("level_id")
      .notNull()
      .references(() => levels.id, { onDelete: "cascade" }),
    lastNumber: integer("last_number").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.productId, t.levelId] })],
);

export const requirementStatuses = pgTable("requirement_statuses", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  // CHECK-constrained (manual migration) to the fixed set the code understands:
  // 'draft' | 'in_review' | 'approved' | 'baselined'. See packages/core.
  category: text("category").notNull(),
  name: text("name").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  isEnabled: boolean("is_enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// One row per tenant (primary key IS the tenant id, not a separate uuid - there's only
// ever one). Governs whether the approval gate on entering the "approved"/"baselined"
// categories requires a formal e-signature and/or a reviewer distinct from the requirement
// version's author. Both default to false ("not required by default", per how this was
// requested) - a tenant opts into stricter process, it isn't forced on them.
export const tenantSettings = pgTable("tenant_settings", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  requireEsignature: boolean("require_esignature").notNull().default(false),
  requireIndependentReview: boolean("require_independent_review").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// One tenant-owned table backs BOTH requirement hierarchy levels (User Need / System
// Requirement / Software Item Spec by default) and test-case levels (Default, by default)
// - `kind` (CHECK-constrained to 'requirement' | 'test', see manual migration; see
// packages/core's LevelKind) is the only thing that distinguishes them. These started as
// two near-identical tables (requirement_levels/test_levels) and were merged: splitting
// them bought nothing (identical shape, identical CRUD - see packages/core/src/levels.ts)
// while costing two real things. First, level_sequence_counters.levelId above couldn't be
// a genuine foreign key - it had to be a bare uuid pointing at whichever of the two tables
// actually owned the id, with nothing in the schema saying which. Second, each kind had
// its own `(tenant_id, code)` uniqueness domain, so a requirement level and a test level
// could silently pick the same code and produce an ambiguous human-readable id (a "TC-1"
// that could mean either a requirement or a test case). One table means one uniqueness
// domain: a code is unique across a tenant's entire id-prefix namespace, period.
//
// sortOrder means something only for kind='requirement': it's the hierarchy itself - a
// lower sortOrder is "more abstract"/higher up, and a requirement's optional parent must
// be at a strictly lower sortOrder than its own level (see packages/core's
// createRequirement). For kind='test' it's just display order; test levels have no
// hierarchy behavior. Neither kind has a fixed "category" the code needs to know special
// behavior for (unlike requirement_statuses), so there's nothing to enable/disable - just
// create, rename, reorder, or delete (delete is refused while any requirement/test case
// still uses that level, or if it's the tenant's last remaining level of that kind).
export const levels = pgTable(
  "levels",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    // The prefix for this level's human-readable sequential IDs (e.g. "SYSREQ" ->
    // SYSREQ-1, SYSREQ-2, ...) - user-editable in Settings, but ONLY while no
    // requirement/test case has been created under this level yet (see
    // packages/core/src/levels.ts's updateLevelCodeOfKind) - once an id has actually been
    // assigned, and potentially exported, signed, or cross-referenced, its prefix is
    // frozen so that id never silently starts meaning something else. Before that point,
    // the id is computed as `${code}-${sequenceNumber}` at read time, not stamped once and
    // frozen - it's the number that's immutable (see level_sequence_counters above), not
    // the prefix.
    code: text("code").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [unique().on(t.tenantId, t.code)],
);

export const requirements = pgTable("requirements", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  productId: uuid("product_id")
    .notNull()
    .references(() => products.id, { onDelete: "cascade" }),
  levelId: uuid("level_id")
    .notNull()
    .references(() => levels.id),
  // The number half of this requirement's human-readable id (e.g. SYSREQ-1 is code
  // "SYSREQ" + sequenceNumber 1, joined at read time - see levels.code). Assigned once,
  // atomically, via level_sequence_counters (see packages/core's nextSequenceNumber) and
  // never reassigned or renumbered afterward, even if the item is later deleted or the
  // level reordered - that's the whole point of it being a traceability id rather than a
  // display position. The table-level unique constraint below is the actual guarantee;
  // the counter is just what makes duplicates unlikely in the first place.
  sequenceNumber: integer("sequence_number").notNull(),
  // Upward trace: optional, user-chosen from a dropdown of same-product requirements at a
  // higher level (lower sortOrder) - see packages/core's createRequirement for the actual
  // hierarchy rule. ON DELETE SET NULL: removing a parent un-parents its children rather
  // than cascading (there's no requirement-deletion UI yet, but this is the safer default
  // whenever one exists).
  parentRequirementId: uuid("parent_requirement_id").references((): AnyPgColumn => requirements.id, {
    onDelete: "set null",
  }),
  // Set after the first version is inserted (see packages/core) - nullable to break the
  // circular reference with requirement_versions below.
  currentVersionId: uuid("current_version_id"),
  createdBy: text("created_by")
    .notNull()
    .references(() => user.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  // The invariant nextSequenceNumber's atomic counter is meant to guarantee, enforced
  // independently at the database level - a bug in the counter, a script, or a future
  // write path that bypasses it can never silently produce two requirements answering to
  // the same human-readable id.
  unique().on(t.productId, t.levelId, t.sequenceNumber),
]);

export const requirementVersions = pgTable("requirement_versions", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  requirementId: uuid("requirement_id")
    .notNull()
    .references(() => requirements.id, { onDelete: "cascade" }),
  versionNumber: integer("version_number").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  // Optional. Sanitized rich-text HTML (see packages/core/src/rich-text.ts), unlike
  // `description` above which predates the rich-text editor and is still plain text -
  // added specifically ahead of the Spira importer, since Spira's own requirement fields
  // are typically rich HTML and this is exactly the kind of free-form context (rationale,
  // strategic fit, etc.) a Spira "Background"-style field tends to hold.
  background: text("background"),
  statusId: uuid("status_id")
    .notNull()
    .references(() => requirementStatuses.id),
  createdBy: text("created_by")
    .notNull()
    .references(() => user.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// --- immutable, hash-chained approval / e-signature log -----------------------------
// Same immutability pattern as audit_log below (REVOKE UPDATE/DELETE + trigger + hash
// chain, see migrations-manual/002). One row per state transition that required an
// e-signature - whether a given transition does depends on the tenant's settings (see
// evaluateApprovalGate in packages/core).

export const approvalEvents = pgTable("approval_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  entityType: text("entity_type").notNull(),
  entityId: uuid("entity_id").notNull(),
  fromStatusId: uuid("from_status_id").references(() => requirementStatuses.id),
  toStatusId: uuid("to_status_id")
    .notNull()
    .references(() => requirementStatuses.id),
  actorUserId: text("actor_user_id")
    .notNull()
    .references(() => user.id),
  typedName: text("typed_name").notNull(),
  reauthAt: timestamp("reauth_at", { withTimezone: true }).notNull(),
  prevHash: text("prev_hash"),
  // Always overwritten by the approval_event_set_hash BEFORE INSERT trigger (see
  // migrations-manual/002) regardless of what's supplied - the "" default just makes it
  // optional at the TS insert layer without misrepresenting who actually owns the value.
  rowHash: text("row_hash").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// --- Test cases, steps, execution, and the file registry backing both evidence and ------
// --- rich-text embedded images (backlog item 4) -----------------------------------------
//
// Test levels (kind='test' in the shared `levels` table above) and environments follow
// the same "tenant-owned rows, not a fixed enum" pattern as requirement levels - a team's
// own test-organization scheme and environment names are preference, not a regulatory
// constant. Unlike requirement levels (seeded with 3 defaults), test levels seed with a
// single "Default" row, matching how most teams start before they need more than one.
//
// Rich text fields (test_steps.description/expected_result/purpose,
// test_step_executions.actual_result) store sanitized HTML - see
// packages/core/src/rich-text.ts for the sanitizer every write path must run through.
// HTML was chosen partly because it's the natural bridge to Spira's own HTML-based
// rich-text fields when the Spira importer (backlog item 8) is actually built.

export const testEnvironments = pgTable("test_environments", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const testCases = pgTable("test_cases", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  productId: uuid("product_id")
    .notNull()
    .references(() => products.id, { onDelete: "cascade" }),
  levelId: uuid("level_id")
    .notNull()
    .references(() => levels.id),
  // The number half of this test case's human-readable id - see requirements.sequenceNumber
  // for the identical mechanism (levels.code + sequenceNumber, joined at read time).
  sequenceNumber: integer("sequence_number").notNull(),
  title: text("title").notNull(),
  createdBy: text("created_by")
    .notNull()
    .references(() => user.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  // Same independent guarantee as requirements' unique constraint above - see its comment.
  unique().on(t.productId, t.levelId, t.sequenceNumber),
]);

export const testSteps = pgTable("test_steps", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  testCaseId: uuid("test_case_id")
    .notNull()
    .references(() => testCases.id, { onDelete: "cascade" }),
  stepNumber: integer("step_number").notNull(),
  description: text("description").notNull(),
  expectedResult: text("expected_result").notNull(),
  purpose: text("purpose"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// Direct test-case-level requirement links, independent of any step link. A test case's
// *effective* traceability is this UNION the requirements linked from any of its steps
// (computed at query time in packages/core, not duplicated into this table when a step
// is linked - "if a step is linked, the test case automatically is" is a read-time rule,
// not a write-time sync).
export const testCaseRequirementLinks = pgTable(
  "test_case_requirement_links",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    testCaseId: uuid("test_case_id")
      .notNull()
      .references(() => testCases.id, { onDelete: "cascade" }),
    requirementId: uuid("requirement_id")
      .notNull()
      .references(() => requirements.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.testCaseId, t.requirementId] })],
);

export const testStepRequirementLinks = pgTable(
  "test_step_requirement_links",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    testStepId: uuid("test_step_id")
      .notNull()
      .references(() => testSteps.id, { onDelete: "cascade" }),
    requirementId: uuid("requirement_id")
      .notNull()
      .references(() => requirements.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.testStepId, t.requirementId] })],
);

export const testExecutions = pgTable("test_executions", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  testCaseId: uuid("test_case_id")
    .notNull()
    .references(() => testCases.id, { onDelete: "cascade" }),
  environmentId: uuid("environment_id")
    .notNull()
    .references(() => testEnvironments.id),
  // CHECK-constrained: 'in_progress' | 'pass' | 'fail' | 'blocked'. Computed as a rollup
  // of step results when the run is completed (see packages/core's completeExecution) -
  // not independently editable.
  status: text("status").notNull().default("in_progress"),
  executedBy: text("executed_by")
    .notNull()
    .references(() => user.id),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const testStepExecutions = pgTable("test_step_executions", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  testExecutionId: uuid("test_execution_id")
    .notNull()
    .references(() => testExecutions.id, { onDelete: "cascade" }),
  testStepId: uuid("test_step_id")
    .notNull()
    .references(() => testSteps.id),
  stepNumber: integer("step_number").notNull(),
  // Snapshotted from the step at the moment the execution started - test_steps isn't
  // versioned the way requirements are, so this is what keeps a historical execution
  // accurate if the step is edited or removed afterwards.
  descriptionSnapshot: text("description_snapshot").notNull(),
  expectedResultSnapshot: text("expected_result_snapshot").notNull(),
  // Evidence is per step: attachments.testStepExecutionId points back at this row, not at
  // the execution as a whole.
  actualResult: text("actual_result"),
  // CHECK-constrained: 'not_run' | 'pass' | 'fail' | 'blocked'.
  status: text("status").notNull().default("not_run"),
  recordedAt: timestamp("recorded_at", { withTimezone: true }),
});

// Generic file registry: a durable "this file belongs to this tenant" record, separate
// from the raw storage key so the app never trusts a client-supplied path. Backs both
// evidence (testStepExecutionId set) and images embedded in any rich-text field (left
// null - referenced only by id from inside the HTML content, resolved through
// /api/attachments/[id] which re-signs a fresh URL from the storage driver on every
// request rather than embedding one that would eventually expire).
export const attachments = pgTable("attachments", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  storageKey: text("storage_key").notNull(),
  contentType: text("content_type").notNull(),
  filename: text("filename").notNull(),
  testStepExecutionId: uuid("test_step_execution_id").references(() => testStepExecutions.id, {
    onDelete: "cascade",
  }),
  createdBy: text("created_by")
    .notNull()
    .references(() => user.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// Single-use enforcement for e-signature re-authentication tokens (TECH_STACK.md
// section 6): consuming a token INSERTs its jti here; the primary key collision on a
// replay makes single-use atomic without any in-memory state (safe across restarts and
// multiple app instances).
export const reauthTokenUses = pgTable("reauth_token_uses", {
  jti: uuid("jti").primaryKey(),
  usedAt: timestamp("used_at", { withTimezone: true }).defaultNow().notNull(),
});

// One row per tenant (like tenant_settings - primary key IS the tenant id). Spira REST
// API credentials for the one-time importer (backlog item 8, packages/integrations/spira).
// The API key is stored in plain text here, not encrypted at rest - same trust boundary as
// the rest of this tenant-isolated, RLS-protected database (no KMS/secrets-encryption
// layer exists in this project yet). Worth knowing before pointing this at a production
// Spira instance; a real encryption-at-rest layer for credentials is a reasonable future
// hardening step, not built now.
export const spiraConnections = pgTable("spira_connections", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  baseUrl: text("base_url").notNull(),
  apiVersion: text("api_version").notNull().default("v6_0"),
  username: text("username").notNull(),
  apiKey: text("api_key").notNull(),
  projectId: integer("project_id").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// One row per tenant, same shape/trust-boundary reasoning as spiraConnections above
// (plaintext key, no KMS layer) - lets each tenant bring their own LLM provider/key for
// AI-assisted test step drafting rather than this app committing to one vendor. `model`
// is a plain string, not an enum - providers add/rename models faster than this app could
// keep a matching list in sync. `baseUrl` is only meaningful (and required, enforced in
// packages/core/src/llm-connection.ts, not here) for provider 'openai_compatible' - a
// self-hosted or third-party OpenAI-compatible endpoint (Ollama, vLLM, Groq, Together,
// DeepSeek, etc); 'anthropic'/'openai' use each provider SDK's own default endpoint.
export const llmConnections = pgTable("llm_connections", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  // CHECK-constrained in migrations-manual (see 012_llm_connections_constraints_and_rls.sql):
  // 'anthropic' | 'openai' | 'openai_compatible'.
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  baseUrl: text("base_url"),
  apiKey: text("api_key").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// Generic "this local entity came from that external system" mapping - deliberately not
// specific to Spira, so a future integration (e.g. Jira, backlog item 8, which also wants
// bidirectional sync) reuses this table rather than growing its own copy per integration.
// Two jobs: (1) import idempotency - on re-import, look up (source, externalId) to update
// the existing local entity instead of creating a duplicate; (2) the foundation a future
// sync-*back* feature would need (write local changes to the source system) - `lastSyncedAt`
// exists for that, but nothing sets it yet, since sync-back itself isn't built.
export const externalLinks = pgTable(
  "external_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    // CHECK-constrained: 'requirement' | 'test_case' | 'test_step' (see manual migration).
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    // CHECK-constrained: 'spira' for now (see manual migration) - extend the constraint,
    // not this column's shape, when a second integration needs this table.
    source: text("source").notNull(),
    externalId: text("external_id").notNull(),
    importedAt: timestamp("imported_at", { withTimezone: true }).defaultNow().notNull(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  },
  (t) => [
    // One link per (entity, source) - an entity can't claim two different external ids
    // from the same source.
    unique("external_links_entity_unique").on(t.tenantId, t.entityType, t.entityId, t.source),
    // One local entity per (source, externalId) - this is the constraint that actually
    // prevents re-importing the same source row as a duplicate.
    unique("external_links_source_unique").on(t.tenantId, t.entityType, t.source, t.externalId),
  ],
);

// --- tenant-defined custom fields (backlog item 9.19) --------------------------------
// A tenant-owned, ordered list of extra fields a team can add to requirements or test
// cases beyond the fixed built-in ones - same "tenant-owned ordered list" shape as
// `levels`, `requirement_statuses`, and `test_environments` elsewhere in this schema, not
// a new pattern. Three tables: the field definitions themselves, each list-type field's
// allowed options, and the actual per-entity values.
//
// Deliberately NOT versioned, and not part of `requirement_versions`: unlike title/
// description/background (which get a new version, a status, and can require e-signature
// on every meaningful change), a custom field is real content, but metadata a team
// corrects directly rather than content an approval workflow needs to track changes to.
// Applying the same non-versioned treatment to both requirements and test cases keeps the
// feature symmetric between them (test cases have no versioning concept at all to hang it
// on anyway). If a specific field later turns out to need approval-gated change tracking,
// that's a real, separate decision to make for that field - not assumed here for all of
// them. Safety Classification (requirements) and Test Type (test cases) are themselves
// just rows in these three tables now, pre-seeded per tenant (see
// packages/core/src/custom-fields.ts's seedDefaultCustomFields) - not a separate concept.
export const customFieldDefinitions = pgTable(
  "custom_field_definitions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    // 'requirement' | 'test_case' - CHECK-constrained (manual migration), same convention
    // as external_links.entityType/audit_log.entityType. A field belongs to exactly one
    // entity type - there's no "shared" custom field between requirements and test cases,
    // matching how every other per-entity concept in this schema (levels included, since
    // the level merge) still distinguishes the two by an explicit column, not inference.
    entityType: text("entity_type").notNull(),
    name: text("name").notNull(),
    // 'short_text' | 'long_text' | 'list' | 'date' | 'integer' | 'boolean' -
    // CHECK-constrained (manual migration). See packages/core's CustomFieldType.
    fieldType: text("field_type").notNull(),
    isRequired: boolean("is_required").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [unique().on(t.tenantId, t.entityType, t.name)],
);

// Allowed values for a field_type='list' definition - meaningless (and left empty) for
// every other field type. A value in custom_field_values below stores one of these rows'
// `id`, not its text, specifically so renaming an option here is free (nothing referencing
// it has to change) - only deleting one that's still in use is blocked (see
// packages/core/src/custom-fields.ts).
export const customFieldListOptions = pgTable(
  "custom_field_list_options",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    fieldId: uuid("field_id")
      .notNull()
      .references(() => customFieldDefinitions.id, { onDelete: "cascade" }),
    value: text("value").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [unique().on(t.fieldId, t.value)],
);

// One row per (field, entity) that actually has a value set - an unset optional field has
// no row at all, rather than a row holding null, so "how many requirements actually filled
// this in" is a plain count. `entityId` is polymorphic (a requirements.id or test_cases.id
// depending on the field's entityType) - same reason it can't be a real FK as
// external_links.entityId/audit_log.entityId above. `value` is always stored as text
// regardless of the field's declared type (an integer as its digits, a boolean as
// "true"/"false", a date as an ISO "YYYY-MM-DD", a list selection as the option's uuid) -
// parsing/formatting by type happens in packages/core, not the database; see
// packages/core/src/custom-fields.ts's validateCustomFieldValue for the one place that
// encoding is defined and enforced.
export const customFieldValues = pgTable(
  "custom_field_values",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    fieldId: uuid("field_id")
      .notNull()
      .references(() => customFieldDefinitions.id, { onDelete: "cascade" }),
    entityId: uuid("entity_id").notNull(),
    value: text("value"),
  },
  (t) => [primaryKey({ columns: [t.fieldId, t.entityId] })],
);

// --- user-definable PDF document templates (backlog item 9.29) ---------------------
// One template belongs to exactly one `scope` - CHECK-constrained (manual migration) to
// 'test_case' | 'test_execution' | 'requirement_list', the three document kinds this
// generates. `htmlTemplate` is raw HTML+CSS with Handlebars placeholders
// ({{title}}, {{#each steps}}...{{/each}}) - rendered against a context built per scope
// (packages/core/src/document-context.ts), then to PDF by wkhtmltopdf
// (packages/documents). Nothing about a generated PDF is ever stored - see that
// package's docstring.

export const documentTemplates = pgTable(
  "document_templates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    name: text("name").notNull(),
    htmlTemplate: text("html_template").notNull(),
    // Handlebars too (same placeholders as htmlTemplate, rendered with escaping off -
    // filenames aren't HTML), rendered per generated file to name it - backlog item
    // 9.31, prompted directly by the user ("template should allow to specify filename
    // format") once bulk generation made a single static name per template
    // (`name` alone) actively wrong: every file in a zip needs its own distinct name.
    // Nullable - an existing template predating this column falls back to its own
    // `name` (see document-context.ts/the generate routes), so nothing needed backfilling.
    filenameTemplate: text("filename_template"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [unique().on(t.tenantId, t.scope, t.name)],
);

// A template's own "additional parameters" (the user asked for exactly this: "specify
// additional parameters of templates that user enters when initiating export") - e.g.
// "Prepared by" or "Approval date", filled in on a small form right before generation
// and exposed to the template as `{{params.<key>}}`. `key` and `label` are deliberately
// separate: `key` is the stable identifier the template body actually references (a
// plain identifier, validated in code - see document-templates.ts), `label` is the
// human-readable prompt shown on that fill-in form - renaming the label (a wording
// tweak) never breaks a template that already references the key.
export const documentTemplateParameters = pgTable(
  "document_template_parameters",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    templateId: uuid("template_id")
      .notNull()
      .references(() => documentTemplates.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    // CHECK-constrained (manual migration): 'text' | 'date'.
    type: text("type").notNull(),
    isRequired: boolean("is_required").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [unique().on(t.templateId, t.key)],
);

// --- immutable, hash-chained audit log ----------------------------------------------
// INSERT-only by grant (REVOKE UPDATE/DELETE) and by trigger (see manual migration),
// enforced at the database level so the app's own credential cannot rewrite history.

// --- operational marker table, walking-skeleton only -------------------------------
// Proves the pg-boss enqueue (web) -> process (worker) round trip actually happened.
// Not tenant data, no RLS - purely a diagnostic table for backlog item 0's checklist.

export const jobPings = pgTable("job_pings", {
  id: uuid("id").defaultRandom().primaryKey(),
  message: text("message").notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }).defaultNow().notNull(),
});

export const auditLog = pgTable("audit_log", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  actorUserId: text("actor_user_id"),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  payload: jsonb("payload"),
  prevHash: text("prev_hash"),
  // Always overwritten by the audit_log_set_hash BEFORE INSERT trigger (see
  // migrations-manual/001) regardless of what's supplied - see the identical note on
  // approvalEvents.rowHash below.
  rowHash: text("row_hash").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
