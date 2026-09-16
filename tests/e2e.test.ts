import { describe, expect, test } from "bun:test";
import { SQL } from "bun";

/**
 * Fast, server-side e2e tests: real HTTP requests against a running `apps/web` (no
 * browser), plus direct Postgres checks for the things that only matter at the database
 * level (immutability, hash chaining). Assumes the stack is already up and migrated:
 *
 *   docker compose up -d
 *   docker compose --profile migrate run --rm migrate
 *   bun test tests/e2e.test.ts
 *
 * Each test registers its own fresh tenant, so tests are independent and can run in any
 * order - no shared fixture state, no cleanup step needed between runs.
 */

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const PG_SUPERUSER_URL =
  process.env.E2E_PG_SUPERUSER_URL ?? "postgres://postgres:postgres_superuser_dev_password@localhost:5432/galm";
const PG_APP_URL = process.env.DATABASE_URL ?? "postgres://app_runtime:app_runtime_dev_password@localhost:5432/galm";

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function parseCookie(res: Response): string {
  const setCookies = res.headers.getSetCookie?.() ?? [];
  return setCookies.map((c) => c.split(";")[0]).join("; ");
}

interface TestTenant {
  cookie: string;
  email: string;
  password: string;
  userId: string;
  tenantId: string;
}

async function registerTenant(orgName: string): Promise<TestTenant> {
  const email = `e2e-${uniqueSuffix()}@example.com`;
  const password = "correct horse battery staple";
  const res = await fetch(`${BASE_URL}/api/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orgName, name: "E2E Tester", email, password }),
  });
  if (!res.ok) {
    throw new Error(`register failed (${res.status}): ${await res.text()}`);
  }
  const cookie = parseCookie(res);
  const body = (await res.json()) as { user: { id: string; tenantId: string } };
  return { cookie, email, password, userId: body.user.id, tenantId: body.user.tenantId };
}

/** Calls a tRPC procedure directly over HTTP - GET for queries, POST for mutations,
 * matching what the fetch adapter actually enforces (a .query() procedure rejects POST
 * and vice versa), so the caller must say which this is. */
async function rpc(
  cookie: string,
  method: "GET" | "POST",
  path: string,
  input?: unknown,
): Promise<{ ok: boolean; status: number; data: any; error?: { message: string } }> {
  const url =
    method === "GET" && input !== undefined
      ? `${BASE_URL}/api/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`
      : `${BASE_URL}/api/trpc/${path}`;
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", cookie },
    body: method === "POST" ? JSON.stringify(input ?? {}) : undefined,
  });
  const body = (await res.json()) as any;
  return { ok: res.ok, status: res.status, data: body?.result?.data, error: body?.error };
}

async function reauth(cookie: string, password: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/reauth`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ password }),
  });
  const body = (await res.json()) as { token?: string; error?: string };
  if (!res.ok || !body.token) throw new Error(`reauth failed: ${body.error}`);
  return body.token;
}

async function uploadAttachment(
  cookie: string,
  content: string,
  filename: string,
  stepExecutionId?: string,
): Promise<{ status: number; ok: boolean; id?: string; url?: string }> {
  const query = stepExecutionId ? `?stepExecutionId=${stepExecutionId}` : "";
  const res = await fetch(`${BASE_URL}/api/attachments/upload${query}`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", cookie, "X-Filename": filename },
    body: content,
  });
  const body = (await res.json().catch(() => ({}))) as { id?: string; url?: string };
  return { status: res.status, ok: res.ok, id: body.id, url: body.url };
}

/** Calls the raw PDF-generation route (backlog item 9.29) - a binary response, so this
 * doesn't go through `rpc()`. Reads the response as bytes regardless of outcome (an error
 * response is JSON, a success is a PDF) so callers can check either shape. */
async function generateDocument(
  cookie: string,
  body: Record<string, unknown>,
): Promise<{ status: number; ok: boolean; contentType: string | null; contentDisposition: string | null; bytes: Uint8Array; error?: string }> {
  const res = await fetch(`${BASE_URL}/api/documents/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify(body),
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  let error: string | undefined;
  if (!res.ok) {
    try {
      error = (JSON.parse(new TextDecoder().decode(bytes)) as { error?: string }).error;
    } catch {
      // leave undefined
    }
  }
  return {
    status: res.status,
    ok: res.ok,
    contentType: res.headers.get("Content-Type"),
    contentDisposition: res.headers.get("Content-Disposition"),
    bytes,
    error,
  };
}

/** Same as generateDocument but for /api/documents/generate-bulk (backlog item 9.32),
 * which streams newline-delimited JSON progress events ending in a `done` (base64 zip)
 * or `error` line (backlog item 9.34) rather than returning a plain file - see that
 * route's own docstring for the exact protocol. A validation failure decided *before*
 * any streaming starts (bad templateId, wrong scope, too many targets) is still a plain
 * non-200 JSON response, distinguished here by its Content-Type not being the streaming
 * one. Reads the whole response with `.text()` rather than a manual chunk-by-chunk
 * reader - this is a correctness/outcome test, not a test of live progress arriving
 * incrementally, so waiting for the full body is the simpler, still-real check; the
 * `progressEvents` this returns are still the *actual* events the server emitted, just
 * collected after the fact instead of watched arrive one at a time. */
async function generateBulkDocument(
  cookie: string,
  body: Record<string, unknown>,
): Promise<{
  status: number;
  ok: boolean;
  error?: string;
  zipBytes?: Uint8Array;
  progressEvents: Array<{ done: number; total: number }>;
}> {
  const res = await fetch(`${BASE_URL}/api/documents/generate-bulk`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify(body),
  });

  if (!res.headers.get("Content-Type")?.includes("application/x-ndjson")) {
    // A pre-stream validation failure - plain JSON error response, nothing to parse
    // line-by-line.
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    return { status: res.status, ok: false, error: json.error, progressEvents: [] };
  }

  const text = await res.text();
  const progressEvents: Array<{ done: number; total: number }> = [];
  let zipBytes: Uint8Array | undefined;
  let error: string | undefined;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line) as
      | { type: "progress"; done: number; total: number }
      | { type: "done"; filename: string; zipBase64: string }
      | { type: "error"; message: string };
    if (msg.type === "progress") progressEvents.push({ done: msg.done, total: msg.total });
    else if (msg.type === "error") error = msg.message;
    else if (msg.type === "done") zipBytes = new Uint8Array(Buffer.from(msg.zipBase64, "base64"));
  }
  return { status: res.status, ok: !error && zipBytes !== undefined, error, zipBytes, progressEvents };
}

/** Reads just the filenames out of a real zip's local file headers, without needing a
 * zip-parsing library (not a workspace dependency of `tests/`, unlike `packages/documents`
 * itself) - a filename is stored uncompressed in each entry's local file header
 * regardless of the entry's own compression method, so this is a correct, real read of
 * what's actually inside the zip the server returned, not a mock. Local file header:
 * signature (4 bytes: 50 4B 03 04) ... filename length at offset 26 (u16 LE) ... filename
 * bytes starting at offset 30. */
function zipEntryNames(bytes: Uint8Array): string[] {
  const names: string[] = [];
  for (let i = 0; i < bytes.length - 4; i++) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x03 && bytes[i + 3] === 0x04) {
      const nameLen = bytes[i + 26]! | (bytes[i + 27]! << 8);
      const nameBytes = bytes.slice(i + 30, i + 30 + nameLen);
      names.push(new TextDecoder().decode(nameBytes));
    }
  }
  return names;
}

/** Shared setup for tests that need a requirement past the draft stage. */
/** Levels are seeded per-tenant (User Need / System Requirement / Software Item Spec by
 * default) rather than a fixed enum - `levelIndex` picks by sortOrder position (0 = the
 * topmost/most-abstract level) since names are no longer fixed either. */
async function createRequirement(
  tenant: TestTenant,
  opts?: { levelIndex?: number; parentRequirementId?: string; productId?: string },
) {
  // A parent must be in the *same* product (see requirements.create's validation), so a
  // caller building a parent/child pair must pass the parent's productId back in here
  // rather than each call getting its own fresh product.
  const productId =
    opts?.productId ?? (await rpc(tenant.cookie, "POST", "products.create", { name: "Test Product" })).data.id;
  const levels = await rpc(tenant.cookie, "GET", "requirements.listLevels");
  const level = levels.data[opts?.levelIndex ?? 0];
  const req = await rpc(tenant.cookie, "POST", "requirements.create", {
    productId,
    levelId: level.id,
    parentRequirementId: opts?.parentRequirementId,
    title: "Test requirement",
    description: "Test description",
  });
  expect(req.ok).toBe(true);
  return {
    productId,
    requirementId: req.data.requirement.id,
    versionId: req.data.version.id,
    levelId: level.id,
  };
}

/** Test Type is a seeded custom field now (see packages/core/src/custom-fields.ts's
 * seedDefaultCustomFields), not a dedicated column - and it's required, so every test
 * that creates a test case needs to supply it explicitly via customFieldValues, same as
 * any other required custom field. Looked up by name/option label rather than a
 * hardcoded id, since seeding assigns a fresh uuid per tenant. */
async function testTypeCustomFieldValue(
  cookie: string,
  label: "Verification" | "Validation",
): Promise<{ fieldId: string; value: string }> {
  const fields = await rpc(cookie, "GET", "settings.listCustomFields", { entityType: "test_case" });
  const field = fields.data.find((f: any) => f.name === "Test Type");
  const option = field.options.find((o: any) => o.value === label);
  return { fieldId: field.id, value: option.id };
}

async function moveToInReview(tenant: TestTenant, requirementId: string) {
  const res = await rpc(tenant.cookie, "POST", "requirements.transition", { requirementId, toCategory: "in_review" });
  expect(res.ok).toBe(true);
}

describe("e2e: requirements lifecycle", () => {
  test("registering seeds default statuses and settings, and a new requirement starts in draft", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);

    const statuses = await rpc(tenant.cookie, "GET", "requirements.listStatuses");
    expect(statuses.ok).toBe(true);
    expect(statuses.data.map((s: any) => s.category).sort()).toEqual(
      ["approved", "baselined", "draft", "in_review"].sort(),
    );

    const settings = await rpc(tenant.cookie, "GET", "settings.get");
    expect(settings.ok).toBe(true);
    expect(settings.data.approval).toEqual({ requireEsignature: false, requireIndependentReview: false });

    const { requirementId } = await createRequirement(tenant);
    const detail = await rpc(tenant.cookie, "GET", "requirements.get", { id: requirementId });
    expect(detail.ok).toBe(true);
    expect(detail.data.versions[0].statusCategory).toBe("draft");
  });

  test("the optional Background field is sanitized rich text, on both create and edit", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "P" });
    const level = (await rpc(tenant.cookie, "GET", "requirements.listLevels")).data[0];

    const created = await rpc(tenant.cookie, "POST", "requirements.create", {
      productId: product.data.id,
      levelId: level.id,
      title: "T",
      description: "D",
      background: '<p>Strategic <b>context</b></p><script>alert(1)</script>',
    });
    expect(created.ok).toBe(true);
    expect(created.data.version.background).toBe("<p>Strategic <b>context</b></p>");

    const edited = await rpc(tenant.cookie, "POST", "requirements.editDraft", {
      requirementId: created.data.requirement.id,
      title: "T",
      description: "D",
      background: "<p>Updated background</p>",
    });
    expect(edited.ok).toBe(true);
    expect(edited.data.background).toBe("<p>Updated background</p>");

    // Optional: creating without one at all must not fail or require it.
    const withoutBackground = await rpc(tenant.cookie, "POST", "requirements.create", {
      productId: product.data.id,
      levelId: level.id,
      title: "T2",
      description: "D2",
    });
    expect(withoutBackground.ok).toBe(true);
    expect(withoutBackground.data.version.background).toBeNull();
  });

  test("by default (e-signature not required), the author can approve their own requirement with no e-sign", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const { requirementId } = await createRequirement(tenant);
    await moveToInReview(tenant, requirementId);

    const approved = await rpc(tenant.cookie, "POST", "requirements.transition", {
      requirementId,
      toCategory: "approved",
    });
    expect(approved.ok).toBe(true);
    expect(approved.data.toStatus.category).toBe("approved");
  });

  test("enabling 'require e-signature' gates approval, accepts a valid one, and rejects a replayed token", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    await rpc(tenant.cookie, "POST", "settings.updateApprovalSettings", { requireEsignature: true });

    const { requirementId } = await createRequirement(tenant);
    await moveToInReview(tenant, requirementId);

    const withoutEsign = await rpc(tenant.cookie, "POST", "requirements.transition", {
      requirementId,
      toCategory: "approved",
    });
    expect(withoutEsign.ok).toBe(false);
    expect(withoutEsign.error?.message).toMatch(/e-signature/);

    const token = await reauth(tenant.cookie, tenant.password);
    const withEsign = await rpc(tenant.cookie, "POST", "requirements.transition", {
      requirementId,
      toCategory: "approved",
      typedName: "E2E Tester",
      reauthToken: token,
    });
    expect(withEsign.ok).toBe(true);
    expect(withEsign.data.toStatus.category).toBe("approved");

    const replay = await rpc(tenant.cookie, "POST", "requirements.transition", {
      requirementId,
      toCategory: "baselined",
      typedName: "E2E Tester",
      reauthToken: token,
    });
    expect(replay.ok).toBe(false);
    expect(replay.error?.message).toMatch(/already used/);
  });

  test("enabling 'require independent review' blocks self-approval", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    await rpc(tenant.cookie, "POST", "settings.updateApprovalSettings", { requireIndependentReview: true });

    const { requirementId } = await createRequirement(tenant);
    await moveToInReview(tenant, requirementId);

    const allowed = await rpc(tenant.cookie, "GET", "requirements.allowedTransitions", { requirementId });
    const approvedOption = allowed.data.allowed.find((a: any) => a.category === "approved");
    expect(approvedOption.blockedByIndependentReview).toBe(true);

    const selfApprove = await rpc(tenant.cookie, "POST", "requirements.transition", {
      requirementId,
      toCategory: "approved",
    });
    expect(selfApprove.ok).toBe(false);
    expect(selfApprove.error?.message).toMatch(/independent review/);
  });

  test("independent review allows approval by someone other than the author", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    await rpc(tenant.cookie, "POST", "settings.updateApprovalSettings", { requireIndependentReview: true });
    const { requirementId, versionId } = await createRequirement(tenant);
    await moveToInReview(tenant, requirementId);

    // No multi-user-per-tenant invite flow exists yet to get a second real session in the
    // same tenant, so the "different author" scenario is set up by pointing the version's
    // createdBy at another real user (borrowed from an unrelated tenant purely to satisfy
    // the foreign key) - the independent-review check only compares raw user ids, so this
    // exercises the real comparison this is testing without needing that flow to exist.
    const otherTenant = await registerTenant(`E2E Org Other ${uniqueSuffix()}`);
    const sql = new SQL(PG_SUPERUSER_URL);
    await sql`update requirement_versions set created_by = ${otherTenant.userId} where id = ${versionId}`;
    await sql.close();

    const approved = await rpc(tenant.cookie, "POST", "requirements.transition", {
      requirementId,
      toCategory: "approved",
    });
    expect(approved.ok).toBe(true);
  });

  test("baselining freezes the version: no further transitions, no edits", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const { requirementId } = await createRequirement(tenant);

    await moveToInReview(tenant, requirementId);
    await rpc(tenant.cookie, "POST", "requirements.transition", { requirementId, toCategory: "approved" });
    const baselined = await rpc(tenant.cookie, "POST", "requirements.transition", {
      requirementId,
      toCategory: "baselined",
    });
    expect(baselined.ok).toBe(true);

    const allowed = await rpc(tenant.cookie, "GET", "requirements.allowedTransitions", { requirementId });
    expect(allowed.data.allowed).toEqual([]);

    const edit = await rpc(tenant.cookie, "POST", "requirements.editDraft", {
      requirementId,
      title: "tamper",
      description: "tamper",
    });
    expect(edit.ok).toBe(false);
  });

  test("RLS: one tenant cannot read another tenant's products or requirements", async () => {
    const tenantA = await registerTenant(`E2E Org A ${uniqueSuffix()}`);
    const tenantB = await registerTenant(`E2E Org B ${uniqueSuffix()}`);
    const { productId: productBId, requirementId: reqBId } = await createRequirement(tenantB);

    const levelsA = await rpc(tenantA.cookie, "GET", "requirements.listLevels");
    const crossList = await rpc(tenantA.cookie, "GET", "requirements.listByProduct", {
      productId: productBId,
      levelId: levelsA.data[0].id,
    });
    expect(crossList.data).toEqual([]);

    const crossGet = await rpc(tenantA.cookie, "GET", "requirements.get", { id: reqBId });
    expect(crossGet.ok).toBe(false);
    expect(crossGet.status).toBe(404);

    const listA = await rpc(tenantA.cookie, "GET", "products.list");
    expect(listA.data.some((p: any) => p.id === productBId)).toBe(false);
  });
});

describe("e2e: requirement hierarchy", () => {
  test("a requirement can optionally trace to a parent at a higher level, visible from both ends", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const parent = await createRequirement(tenant, { levelIndex: 0 });
    const child = await createRequirement(tenant, {
      levelIndex: 1,
      parentRequirementId: parent.requirementId,
      productId: parent.productId,
    });

    const childDetail = await rpc(tenant.cookie, "GET", "requirements.get", { id: child.requirementId });
    expect(childDetail.data.requirement.parentRequirementId).toBe(parent.requirementId);
    expect(childDetail.data.requirement.parentTitle).toBe("Test requirement");

    const parentDetail = await rpc(tenant.cookie, "GET", "requirements.get", { id: parent.requirementId });
    expect(parentDetail.data.children.some((c: any) => c.id === child.requirementId)).toBe(true);
  });

  test("a parent must be at a strictly higher level - same or lower level is rejected", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const first = await createRequirement(tenant, { levelIndex: 0 });

    const sameLevel = await rpc(tenant.cookie, "POST", "requirements.create", {
      productId: first.productId,
      levelId: first.levelId,
      parentRequirementId: first.requirementId,
      title: "Invalid sibling-as-parent",
      description: "D",
    });
    expect(sameLevel.ok).toBe(false);
    expect(sameLevel.error?.message).toMatch(/higher level/);

    const lower = await createRequirement(tenant, { levelIndex: 1 });
    const lowerAsParent = await rpc(tenant.cookie, "POST", "requirements.create", {
      productId: first.productId,
      levelId: first.levelId,
      parentRequirementId: lower.requirementId,
      title: "Invalid lower-as-parent",
      description: "D",
    });
    expect(lowerAsParent.ok).toBe(false);
  });

  test("a parent must belong to the same product", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const inOneProduct = await createRequirement(tenant, { levelIndex: 0 });
    const otherProduct = await rpc(tenant.cookie, "POST", "products.create", { name: "Other Product" });
    const levels = await rpc(tenant.cookie, "GET", "requirements.listLevels");

    const crossProduct = await rpc(tenant.cookie, "POST", "requirements.create", {
      productId: otherProduct.data.id,
      levelId: levels.data[1].id,
      parentRequirementId: inOneProduct.requirementId,
      title: "Cross-product parent",
      description: "D",
    });
    expect(crossProduct.ok).toBe(false);
    expect(crossProduct.error?.message).toMatch(/same product/);
  });

  test("listParentCandidates only returns same-product requirements at a strictly higher level", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const topLevel = await createRequirement(tenant, { levelIndex: 0 });
    const midLevel = await createRequirement(tenant, { levelIndex: 1, productId: topLevel.productId });

    const candidatesForBottom = await rpc(tenant.cookie, "GET", "requirements.listParentCandidates", {
      productId: topLevel.productId,
      levelId: (await rpc(tenant.cookie, "GET", "requirements.listLevels")).data[2].id,
    });
    const candidateIds = candidatesForBottom.data.map((c: any) => c.id);
    expect(candidateIds).toContain(topLevel.requirementId);
    expect(candidateIds).toContain(midLevel.requirementId);

    const candidatesForTop = await rpc(tenant.cookie, "GET", "requirements.listParentCandidates", {
      productId: topLevel.productId,
      levelId: topLevel.levelId,
    });
    expect(candidatesForTop.data).toEqual([]);
  });
});

describe("e2e: settings - managing statuses", () => {
  test("renaming and disabling a status, and the fixed categories that refuse to be disabled", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const initial = await rpc(tenant.cookie, "GET", "settings.get");
    const inReview = initial.data.statuses.find((s: any) => s.category === "in_review");
    const draft = initial.data.statuses.find((s: any) => s.category === "draft");

    const renamed = await rpc(tenant.cookie, "POST", "settings.renameStatus", {
      statusId: inReview.id,
      name: "Peer Review",
    });
    expect(renamed.ok).toBe(true);
    expect(renamed.data.name).toBe("Peer Review");

    const disabled = await rpc(tenant.cookie, "POST", "settings.setStatusEnabled", {
      statusId: inReview.id,
      enabled: false,
    });
    expect(disabled.ok).toBe(true);
    expect(disabled.data.isEnabled).toBe(false);

    const cannotDisableDraft = await rpc(tenant.cookie, "POST", "settings.setStatusEnabled", {
      statusId: draft.id,
      enabled: false,
    });
    expect(cannotDisableDraft.ok).toBe(false);
    expect(cannotDisableDraft.error?.message).toMatch(/cannot be disabled/);
  });

  test("disabling 'in_review' collapses draft's transitions straight to 'approved'", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const settings = await rpc(tenant.cookie, "GET", "settings.get");
    const inReview = settings.data.statuses.find((s: any) => s.category === "in_review");
    await rpc(tenant.cookie, "POST", "settings.setStatusEnabled", { statusId: inReview.id, enabled: false });

    const { requirementId } = await createRequirement(tenant);
    const allowed = await rpc(tenant.cookie, "GET", "requirements.allowedTransitions", { requirementId });
    expect(allowed.data.allowed.map((a: any) => a.category)).toEqual(["approved"]);
  });

  test("cross-tenant isolation: one tenant cannot rename another tenant's status", async () => {
    const tenantA = await registerTenant(`E2E Org A ${uniqueSuffix()}`);
    const tenantB = await registerTenant(`E2E Org B ${uniqueSuffix()}`);
    const settingsB = await rpc(tenantB.cookie, "GET", "settings.get");
    const draftB = settingsB.data.statuses.find((s: any) => s.category === "draft");

    const rename = await rpc(tenantA.cookie, "POST", "settings.renameStatus", {
      statusId: draftB.id,
      name: "Hijacked",
    });
    expect(rename.ok).toBe(false);
  });
});

describe("e2e: settings - managing hierarchy levels", () => {
  test("registering seeds the three default levels in order", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const settings = await rpc(tenant.cookie, "GET", "settings.get");
    expect(settings.data.levels.map((l: any) => l.name)).toEqual([
      "User Need",
      "System Requirement",
      "Software Item Spec",
    ]);
  });

  test("create, rename, and reorder a level", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const created = await rpc(tenant.cookie, "POST", "settings.createLevel", { name: "Detailed Design", code: "DETDESIGN" });
    expect(created.ok).toBe(true);

    const renamed = await rpc(tenant.cookie, "POST", "settings.renameLevel", {
      levelId: created.data.id,
      name: "Software Detailed Design",
    });
    expect(renamed.ok).toBe(true);
    expect(renamed.data.name).toBe("Software Detailed Design");

    // New level is appended last; move it up one and confirm the order actually changed.
    const before = await rpc(tenant.cookie, "GET", "settings.get");
    const indexBefore = before.data.levels.findIndex((l: any) => l.id === created.data.id);
    await rpc(tenant.cookie, "POST", "settings.reorderLevel", { levelId: created.data.id, direction: "up" });
    const after = await rpc(tenant.cookie, "GET", "settings.get");
    const indexAfter = after.data.levels.findIndex((l: any) => l.id === created.data.id);
    expect(indexAfter).toBe(indexBefore - 1);
  });

  test("a level in use cannot be deleted, but an unused one can", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const { levelId } = await createRequirement(tenant, { levelIndex: 0 });

    const blocked = await rpc(tenant.cookie, "POST", "settings.deleteLevel", { levelId });
    expect(blocked.ok).toBe(false);
    expect(blocked.error?.message).toMatch(/requirements using it/);

    const unused = await rpc(tenant.cookie, "POST", "settings.createLevel", { name: "Unused Level", code: "UNUSED" });
    const deleted = await rpc(tenant.cookie, "POST", "settings.deleteLevel", { levelId: unused.data.id });
    expect(deleted.ok).toBe(true);
  });

  test("the last remaining level cannot be deleted", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const settings = await rpc(tenant.cookie, "GET", "settings.get");
    for (const level of settings.data.levels.slice(1)) {
      const res = await rpc(tenant.cookie, "POST", "settings.deleteLevel", { levelId: level.id });
      expect(res.ok).toBe(true);
    }
    const lastOne = settings.data.levels[0];
    const lastDeleteAttempt = await rpc(tenant.cookie, "POST", "settings.deleteLevel", { levelId: lastOne.id });
    expect(lastDeleteAttempt.ok).toBe(false);
    expect(lastDeleteAttempt.error?.message).toMatch(/only remaining level/);
  });
});

describe("e2e: audit trail integrity (direct database checks)", () => {
  test("every status transition writes an audit_log row, independent of approval_events", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const { requirementId, versionId } = await createRequirement(tenant);
    await moveToInReview(tenant, requirementId);

    const sql = new SQL(PG_SUPERUSER_URL);
    const rows =
      await sql`select action from audit_log where entity_id = ${versionId} and entity_type = 'requirement_version'`;
    await sql.close();

    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.some((r: any) => r.action === "requirement.status_changed")).toBe(true);
  });

  test("approval_events rows cannot be updated by app_runtime, the app's own credential", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    await rpc(tenant.cookie, "POST", "settings.updateApprovalSettings", { requireEsignature: true });
    const { requirementId } = await createRequirement(tenant);
    await moveToInReview(tenant, requirementId);
    const token = await reauth(tenant.cookie, tenant.password);
    await rpc(tenant.cookie, "POST", "requirements.transition", {
      requirementId,
      toCategory: "approved",
      typedName: "E2E",
      reauthToken: token,
    });

    const superuserSql = new SQL(PG_SUPERUSER_URL);
    const [row] = await superuserSql`
      select id from approval_events where actor_user_id = ${tenant.userId} order by created_at desc limit 1
    `;
    await superuserSql.close();
    expect(row).toBeDefined();

    const appSql = new SQL(PG_APP_URL);
    let threw = false;
    try {
      await appSql`update approval_events set typed_name = 'HACKED' where id = ${row.id}`;
    } catch {
      threw = true;
    }
    await appSql.close();
    expect(threw).toBe(true);
  });

  test("approval_events row hashes chain correctly within a tenant", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    await rpc(tenant.cookie, "POST", "settings.updateApprovalSettings", { requireEsignature: true });
    const { requirementId } = await createRequirement(tenant);
    await moveToInReview(tenant, requirementId);

    let token = await reauth(tenant.cookie, tenant.password);
    await rpc(tenant.cookie, "POST", "requirements.transition", {
      requirementId,
      toCategory: "approved",
      typedName: "E2E",
      reauthToken: token,
    });
    token = await reauth(tenant.cookie, tenant.password);
    await rpc(tenant.cookie, "POST", "requirements.transition", {
      requirementId,
      toCategory: "baselined",
      typedName: "E2E",
      reauthToken: token,
    });

    const sql = new SQL(PG_SUPERUSER_URL);
    const rows = await sql`
      select prev_hash, row_hash from approval_events
      where actor_user_id = ${tenant.userId}
      order by created_at asc
    `;
    await sql.close();

    expect(rows.length).toBe(2);
    expect(rows[1].prev_hash).toBe(rows[0].row_hash);
  });
});

describe("e2e: test cases", () => {
  test("registering seeds one default test level and one default environment", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const levels = await rpc(tenant.cookie, "GET", "testCases.listLevels");
    expect(levels.data.map((l: any) => l.name)).toEqual(["Default"]);
    const environments = await rpc(tenant.cookie, "GET", "testCases.listEnvironments");
    expect(environments.data.map((e: any) => e.name)).toEqual(["Default"]);
  });

  test("a step-level requirement link makes the test case effectively linked too, and rich text is sanitized", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "P" });
    const reqLevel = (await rpc(tenant.cookie, "GET", "requirements.listLevels")).data[0];
    const requirement = await rpc(tenant.cookie, "POST", "requirements.create", {
      productId: product.data.id,
      levelId: reqLevel.id,
      title: "Req",
      description: "D",
    });
    const testLevel = (await rpc(tenant.cookie, "GET", "testCases.listLevels")).data[0];

    const testCase = await rpc(tenant.cookie, "POST", "testCases.create", {
      productId: product.data.id,
      levelId: testLevel.id,
      customFieldValues: [await testTypeCustomFieldValue(tenant.cookie, "Verification")],
      title: "TC",
      steps: [
        {
          description: '<p>Open <b>login</b></p><script>alert(1)</script>',
          expectedResult: "<p>Loads</p><table><tr><td>ok</td></tr></table>",
          requirementIds: [requirement.data.requirement.id],
        },
      ],
    });
    expect(testCase.ok).toBe(true);
    // Sanitized: bold/table kept, script stripped.
    expect(testCase.data.steps[0].description).toBe("<p>Open <b>login</b></p>");
    expect(testCase.data.steps[0].description).not.toContain("script");
    expect(testCase.data.steps[0].expectedResult).toContain("<table>");

    const detail = await rpc(tenant.cookie, "GET", "testCases.get", { id: testCase.data.testCase.id });
    expect(detail.data.effectiveRequirementLinks.map((r: any) => r.id)).toEqual([requirement.data.requirement.id]);
  });

  test("a test case needs at least one step", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "P" });
    const testLevel = (await rpc(tenant.cookie, "GET", "testCases.listLevels")).data[0];
    const res = await rpc(tenant.cookie, "POST", "testCases.create", {
      productId: product.data.id,
      levelId: testLevel.id,
      customFieldValues: [await testTypeCustomFieldValue(tenant.cookie, "Verification")],
      title: "TC",
      steps: [],
    });
    expect(res.ok).toBe(false);
  });

  test("execution: cannot complete with unrecorded steps; overall status rolls up (fail beats blocked beats pass)", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "P" });
    const testLevel = (await rpc(tenant.cookie, "GET", "testCases.listLevels")).data[0];
    const environment = (await rpc(tenant.cookie, "GET", "testCases.listEnvironments")).data[0];

    const testCase = await rpc(tenant.cookie, "POST", "testCases.create", {
      productId: product.data.id,
      levelId: testLevel.id,
      customFieldValues: [await testTypeCustomFieldValue(tenant.cookie, "Validation")],
      title: "TC",
      steps: [
        { description: "<p>Step 1</p>", expectedResult: "<p>Expected 1</p>" },
        { description: "<p>Step 2</p>", expectedResult: "<p>Expected 2</p>" },
        { description: "<p>Step 3</p>", expectedResult: "<p>Expected 3</p>" },
      ],
    });

    const execution = await rpc(tenant.cookie, "POST", "testCases.startExecution", {
      testCaseId: testCase.data.testCase.id,
      environmentId: environment.id,
    });
    expect(execution.data.stepExecutions.length).toBe(3);
    const [s1, s2, s3] = execution.data.stepExecutions;

    const tooEarly = await rpc(tenant.cookie, "POST", "testCases.completeExecution", {
      executionId: execution.data.execution.id,
    });
    expect(tooEarly.ok).toBe(false);
    expect(tooEarly.error?.message).toMatch(/must be recorded/);

    await rpc(tenant.cookie, "POST", "testCases.recordStepResult", {
      testStepExecutionId: s1.id,
      actualResult: "<p>ok</p>",
      status: "pass",
    });
    await rpc(tenant.cookie, "POST", "testCases.recordStepResult", {
      testStepExecutionId: s2.id,
      actualResult: "<p>blocked by env</p>",
      status: "blocked",
    });
    await rpc(tenant.cookie, "POST", "testCases.recordStepResult", {
      testStepExecutionId: s3.id,
      actualResult: "<p>broke</p>",
      status: "fail",
    });

    const completed = await rpc(tenant.cookie, "POST", "testCases.completeExecution", {
      executionId: execution.data.execution.id,
    });
    expect(completed.ok).toBe(true);
    expect(completed.data.status).toBe("fail"); // fail beats blocked beats pass

    const again = await rpc(tenant.cookie, "POST", "testCases.completeExecution", {
      executionId: execution.data.execution.id,
    });
    expect(again.ok).toBe(false);
    expect(again.error?.message).toMatch(/already completed/);
  });

  test("evidence is per step: uploaded evidence round-trips and is isolated per tenant", async () => {
    const tenantA = await registerTenant(`E2E Org A ${uniqueSuffix()}`);
    const tenantB = await registerTenant(`E2E Org B ${uniqueSuffix()}`);

    const product = await rpc(tenantA.cookie, "POST", "products.create", { name: "P" });
    const testLevel = (await rpc(tenantA.cookie, "GET", "testCases.listLevels")).data[0];
    const environment = (await rpc(tenantA.cookie, "GET", "testCases.listEnvironments")).data[0];
    const testCase = await rpc(tenantA.cookie, "POST", "testCases.create", {
      productId: product.data.id,
      levelId: testLevel.id,
      customFieldValues: [await testTypeCustomFieldValue(tenantA.cookie, "Verification")],
      title: "TC",
      steps: [{ description: "<p>S</p>", expectedResult: "<p>E</p>" }],
    });
    const execution = await rpc(tenantA.cookie, "POST", "testCases.startExecution", {
      testCaseId: testCase.data.testCase.id,
      environmentId: environment.id,
    });
    const stepExecutionId = execution.data.stepExecutions[0].id;

    const content = `evidence-${uniqueSuffix()}`;
    const uploaded = await uploadAttachment(tenantA.cookie, content, "note.txt", stepExecutionId);
    expect(uploaded.ok).toBe(true);
    expect(uploaded.id).toBeDefined();

    const fetched = await fetch(`${BASE_URL}/api/attachments/${uploaded.id}`, {
      headers: { cookie: tenantA.cookie },
      redirect: "follow",
    });
    expect(fetched.ok).toBe(true);
    expect(await fetched.text()).toBe(content);

    const crossTenantFetch = await fetch(`${BASE_URL}/api/attachments/${uploaded.id}`, {
      headers: { cookie: tenantB.cookie },
      redirect: "manual",
    });
    expect(crossTenantFetch.status).toBe(404);

    const executionDetail = await rpc(tenantA.cookie, "GET", "testCases.getExecution", { id: execution.data.execution.id });
    expect(executionDetail.data.stepExecutions[0].evidence.map((e: any) => e.id)).toContain(uploaded.id);
  });
});

describe("e2e: deleting requirements and test cases (backlog item 9.27)", () => {
  test("a Draft requirement with no covering test case can be deleted", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const { requirementId } = await createRequirement(tenant);

    const del = await rpc(tenant.cookie, "POST", "requirements.delete", { id: requirementId });
    expect(del.ok).toBe(true);

    const detail = await rpc(tenant.cookie, "GET", "requirements.get", { id: requirementId });
    expect(detail.ok).toBe(false);
    expect(detail.status).toBe(404);
  });

  test("a requirement that has moved past Draft cannot be deleted", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const { requirementId } = await createRequirement(tenant);
    await moveToInReview(tenant, requirementId);

    const del = await rpc(tenant.cookie, "POST", "requirements.delete", { id: requirementId });
    expect(del.ok).toBe(false);
    expect(del.error?.message).toMatch(/Draft/);

    // Refused, not silently ignored - the requirement is still there afterward.
    const detail = await rpc(tenant.cookie, "GET", "requirements.get", { id: requirementId });
    expect(detail.ok).toBe(true);
  });

  test("a requirement with a covering test case cannot be deleted until the link is removed", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const { productId, requirementId } = await createRequirement(tenant);
    const testLevel = (await rpc(tenant.cookie, "GET", "testCases.listLevels")).data[0];
    const testCase = await rpc(tenant.cookie, "POST", "testCases.create", {
      productId,
      levelId: testLevel.id,
      customFieldValues: [await testTypeCustomFieldValue(tenant.cookie, "Verification")],
      title: "TC",
      requirementIds: [requirementId],
      steps: [{ description: "<p>S</p>", expectedResult: "<p>E</p>" }],
    });
    expect(testCase.ok).toBe(true);

    const blocked = await rpc(tenant.cookie, "POST", "requirements.delete", { id: requirementId });
    expect(blocked.ok).toBe(false);
    expect(blocked.error?.message).toMatch(/covering test case/);

    // Deleting the test case that was the only thing covering it removes the obstacle.
    const del = await rpc(tenant.cookie, "POST", "testCases.delete", { id: testCase.data.testCase.id });
    expect(del.ok).toBe(true);
    const nowDeletable = await rpc(tenant.cookie, "POST", "requirements.delete", { id: requirementId });
    expect(nowDeletable.ok).toBe(true);
  });

  test("deleting a requirement writes an immutable audit_log entry and cleans up its external_links row", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const { requirementId } = await createRequirement(tenant);

    // Simulate this requirement having come from an import (Spira) - createRequirement
    // via the plain HTTP API doesn't go through that path, so this row is inserted
    // directly, the same "set up state the API surface can't reach" technique the
    // independent-review test above uses.
    const setupSql = new SQL(PG_SUPERUSER_URL);
    await setupSql`
      insert into external_links (tenant_id, entity_type, entity_id, source, external_id)
      values (${tenant.tenantId}, 'requirement', ${requirementId}, 'spira', '999')
    `;
    await setupSql.close();

    const del = await rpc(tenant.cookie, "POST", "requirements.delete", { id: requirementId });
    expect(del.ok).toBe(true);

    const checkSql = new SQL(PG_SUPERUSER_URL);
    const auditRows =
      await checkSql`select action, payload from audit_log where entity_id = ${requirementId} and entity_type = 'requirement' and action = 'requirement.deleted'`;
    const linkRows =
      await checkSql`select id from external_links where tenant_id = ${tenant.tenantId} and entity_type = 'requirement' and entity_id = ${requirementId}`;
    await checkSql.close();

    expect(auditRows.length).toBe(1);
    // audit_log.payload comes back from the raw SQL client as a JSON string - the jsonb
    // column itself stores a double-encoded string for every audit entry in this app
    // (pre-existing, not introduced here; nothing reads payload back anywhere yet, so it
    // was never noticed) - parse it the same way any future audit-log reader will have to.
    expect(JSON.parse(auditRows[0].payload).title).toBe("Test requirement");
    // Cleaned up so a future re-import of Spira id 999 creates a fresh requirement
    // instead of crashing looking up an entity that no longer exists.
    expect(linkRows.length).toBe(0);
  });

  test("a test case with no execution history can be deleted", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "P" });
    const testLevel = (await rpc(tenant.cookie, "GET", "testCases.listLevels")).data[0];
    const testCase = await rpc(tenant.cookie, "POST", "testCases.create", {
      productId: product.data.id,
      levelId: testLevel.id,
      customFieldValues: [await testTypeCustomFieldValue(tenant.cookie, "Verification")],
      title: "TC",
      steps: [{ description: "<p>S</p>", expectedResult: "<p>E</p>" }],
    });

    const del = await rpc(tenant.cookie, "POST", "testCases.delete", { id: testCase.data.testCase.id });
    expect(del.ok).toBe(true);

    const detail = await rpc(tenant.cookie, "GET", "testCases.get", { id: testCase.data.testCase.id });
    expect(detail.ok).toBe(false);
    expect(detail.status).toBe(404);
  });

  test("a test case with execution history cannot be deleted - historical evidence must stay resolvable", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "P" });
    const testLevel = (await rpc(tenant.cookie, "GET", "testCases.listLevels")).data[0];
    const environment = (await rpc(tenant.cookie, "GET", "testCases.listEnvironments")).data[0];
    const testCase = await rpc(tenant.cookie, "POST", "testCases.create", {
      productId: product.data.id,
      levelId: testLevel.id,
      customFieldValues: [await testTypeCustomFieldValue(tenant.cookie, "Verification")],
      title: "TC",
      steps: [{ description: "<p>S</p>", expectedResult: "<p>E</p>" }],
    });
    await rpc(tenant.cookie, "POST", "testCases.startExecution", {
      testCaseId: testCase.data.testCase.id,
      environmentId: environment.id,
    });

    const blocked = await rpc(tenant.cookie, "POST", "testCases.delete", { id: testCase.data.testCase.id });
    expect(blocked.ok).toBe(false);
    expect(blocked.error?.message).toMatch(/execution/);

    const detail = await rpc(tenant.cookie, "GET", "testCases.get", { id: testCase.data.testCase.id });
    expect(detail.ok).toBe(true);
  });

  test("RLS: one tenant cannot delete another tenant's requirement or test case", async () => {
    const tenantA = await registerTenant(`E2E Org A ${uniqueSuffix()}`);
    const tenantB = await registerTenant(`E2E Org B ${uniqueSuffix()}`);
    const { requirementId: reqBId, productId } = await createRequirement(tenantB);
    const testLevel = (await rpc(tenantB.cookie, "GET", "testCases.listLevels")).data[0];
    const testCaseB = await rpc(tenantB.cookie, "POST", "testCases.create", {
      productId,
      levelId: testLevel.id,
      customFieldValues: [await testTypeCustomFieldValue(tenantB.cookie, "Verification")],
      title: "TC",
      steps: [{ description: "<p>S</p>", expectedResult: "<p>E</p>" }],
    });

    const delReq = await rpc(tenantA.cookie, "POST", "requirements.delete", { id: reqBId });
    expect(delReq.ok).toBe(false);
    const delTc = await rpc(tenantA.cookie, "POST", "testCases.delete", { id: testCaseB.data.testCase.id });
    expect(delTc.ok).toBe(false);

    // Both untouched - still visible to their real owner.
    const stillThereReq = await rpc(tenantB.cookie, "GET", "requirements.get", { id: reqBId });
    expect(stillThereReq.ok).toBe(true);
    const stillThereTc = await rpc(tenantB.cookie, "GET", "testCases.get", { id: testCaseB.data.testCase.id });
    expect(stillThereTc.ok).toBe(true);
  });

  test("backlog item 9.28: deleting the tip (highest-numbered item) reclaims its number for the next create", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const a = await createRequirement(tenant);
    const b = await createRequirement(tenant, { productId: a.productId });
    const bGet = await rpc(tenant.cookie, "GET", "requirements.get", { id: b.requirementId });
    expect(bGet.data.requirement.sequenceNumber).toBe(2);

    const del = await rpc(tenant.cookie, "POST", "requirements.delete", { id: b.requirementId });
    expect(del.ok).toBe(true);

    const c = await createRequirement(tenant, { productId: a.productId });
    const cGet = await rpc(tenant.cookie, "GET", "requirements.get", { id: c.requirementId });
    // Reused, not 3 - deleting #2 (the tip at the time) gave the number back.
    expect(cGet.data.requirement.sequenceNumber).toBe(2);
  });

  test("deleting a non-tip item (something else was created after it) leaves a permanent gap - never reclaimed", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const a = await createRequirement(tenant);
    const b = await createRequirement(tenant, { productId: a.productId });
    // b (#2) now exists, so a (#1) is no longer the tip.

    const del = await rpc(tenant.cookie, "POST", "requirements.delete", { id: a.requirementId });
    expect(del.ok).toBe(true);

    const c = await createRequirement(tenant, { productId: a.productId });
    const cGet = await rpc(tenant.cookie, "GET", "requirements.get", { id: c.requirementId });
    // #3, not #1 - #1 wasn't the tip when it was deleted, so its number stays permanently
    // gone, same behavior as before backlog item 9.28.
    expect(cGet.data.requirement.sequenceNumber).toBe(3);
  });

  test("repeated tip deletes walk the counter back correctly, one at a time", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const a = await createRequirement(tenant);
    const b = await createRequirement(tenant, { productId: a.productId });
    const c = await createRequirement(tenant, { productId: a.productId });
    const cGet = await rpc(tenant.cookie, "GET", "requirements.get", { id: c.requirementId });
    expect(cGet.data.requirement.sequenceNumber).toBe(3);

    // Delete #3 (the tip), then #2 (now the new tip) - both reclaims.
    expect((await rpc(tenant.cookie, "POST", "requirements.delete", { id: c.requirementId })).ok).toBe(true);
    expect((await rpc(tenant.cookie, "POST", "requirements.delete", { id: b.requirementId })).ok).toBe(true);

    const d = await createRequirement(tenant, { productId: a.productId });
    const dGet = await rpc(tenant.cookie, "GET", "requirements.get", { id: d.requirementId });
    // Back to #2, not #4 - both deletes walked the counter back one step at a time.
    expect(dGet.data.requirement.sequenceNumber).toBe(2);
  });

  test("deleting the tip test case reclaims its number the same way", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "P" });
    const testLevel = (await rpc(tenant.cookie, "GET", "testCases.listLevels")).data[0];
    const step = { description: "<p>S</p>", expectedResult: "<p>E</p>" };
    const tc1 = await rpc(tenant.cookie, "POST", "testCases.create", {
      productId: product.data.id,
      levelId: testLevel.id,
      customFieldValues: [await testTypeCustomFieldValue(tenant.cookie, "Verification")],
      title: "TC1",
      steps: [step],
    });
    const tc2 = await rpc(tenant.cookie, "POST", "testCases.create", {
      productId: product.data.id,
      levelId: testLevel.id,
      customFieldValues: [await testTypeCustomFieldValue(tenant.cookie, "Verification")],
      title: "TC2",
      steps: [step],
    });
    expect(tc2.data.testCase.sequenceNumber).toBe(2);

    const del = await rpc(tenant.cookie, "POST", "testCases.delete", { id: tc2.data.testCase.id });
    expect(del.ok).toBe(true);

    const tc3 = await rpc(tenant.cookie, "POST", "testCases.create", {
      productId: product.data.id,
      levelId: testLevel.id,
      customFieldValues: [await testTypeCustomFieldValue(tenant.cookie, "Verification")],
      title: "TC3",
      steps: [step],
    });
    expect(tc3.data.testCase.sequenceNumber).toBe(2);
  });
});

describe("e2e: settings - managing test levels and environments", () => {
  test("create, rename, reorder a test level; a level in use cannot be deleted", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const created = await rpc(tenant.cookie, "POST", "settings.createTestLevel", { name: "Regression", code: "REGRESSION" });
    expect(created.ok).toBe(true);

    const renamed = await rpc(tenant.cookie, "POST", "settings.renameTestLevel", {
      levelId: created.data.id,
      name: "Regression Suite",
    });
    expect(renamed.data.name).toBe("Regression Suite");

    const before = await rpc(tenant.cookie, "GET", "settings.get");
    const indexBefore = before.data.testLevels.findIndex((l: any) => l.id === created.data.id);
    await rpc(tenant.cookie, "POST", "settings.reorderTestLevel", { levelId: created.data.id, direction: "up" });
    const after = await rpc(tenant.cookie, "GET", "settings.get");
    expect(after.data.testLevels.findIndex((l: any) => l.id === created.data.id)).toBe(indexBefore - 1);

    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "P" });
    await rpc(tenant.cookie, "POST", "testCases.create", {
      productId: product.data.id,
      levelId: created.data.id,
      customFieldValues: [await testTypeCustomFieldValue(tenant.cookie, "Verification")],
      title: "TC",
      steps: [{ description: "<p>S</p>", expectedResult: "<p>E</p>" }],
    });
    const blocked = await rpc(tenant.cookie, "POST", "settings.deleteTestLevel", { levelId: created.data.id });
    expect(blocked.ok).toBe(false);
    expect(blocked.error?.message).toMatch(/test cases using it/);
  });

  test("the last remaining environment cannot be deleted; an unused one can", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const onlyOne = (await rpc(tenant.cookie, "GET", "settings.get")).data.environments[0];
    const lastDelete = await rpc(tenant.cookie, "POST", "settings.deleteEnvironment", { environmentId: onlyOne.id });
    expect(lastDelete.ok).toBe(false);
    expect(lastDelete.error?.message).toMatch(/only remaining environment/);

    const extra = await rpc(tenant.cookie, "POST", "settings.createEnvironment", { name: "Staging" });
    const deleted = await rpc(tenant.cookie, "POST", "settings.deleteEnvironment", { environmentId: extra.data.id });
    expect(deleted.ok).toBe(true);
  });
});

describe("e2e: sequential per-level human-readable ids", () => {
  test("requirements get sequential numbers per (product, level), starting at 1 and never reused", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const a = await createRequirement(tenant);
    const b = await createRequirement(tenant, { productId: a.productId });
    expect(a.levelId).toBe(b.levelId);

    const aGet = await rpc(tenant.cookie, "GET", "requirements.get", { id: a.requirementId });
    const bGet = await rpc(tenant.cookie, "GET", "requirements.get", { id: b.requirementId });
    expect(aGet.data.requirement.sequenceNumber).toBe(1);
    expect(bGet.data.requirement.sequenceNumber).toBe(2);
    expect(aGet.data.requirement.levelCode).toBe(bGet.data.requirement.levelCode);

    // A second, unrelated product's same-named level starts its own numbering back at 1 -
    // ids are scoped per product, not shared tenant-wide.
    const c = await createRequirement(tenant);
    const cGet = await rpc(tenant.cookie, "GET", "requirements.get", { id: c.requirementId });
    expect(cGet.data.requirement.sequenceNumber).toBe(1);
  });

  test("test cases get sequential numbers the same way", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "P" });
    const levels = await rpc(tenant.cookie, "GET", "testCases.listLevels");
    const levelId = levels.data[0].id;
    const step = { description: "<p>S</p>", expectedResult: "<p>E</p>" };

    const tc1 = await rpc(tenant.cookie, "POST", "testCases.create", {
      productId: product.data.id,
      levelId,
      customFieldValues: [await testTypeCustomFieldValue(tenant.cookie, "Verification")],
      title: "TC1",
      steps: [step],
    });
    const tc2 = await rpc(tenant.cookie, "POST", "testCases.create", {
      productId: product.data.id,
      levelId,
      customFieldValues: [await testTypeCustomFieldValue(tenant.cookie, "Verification")],
      title: "TC2",
      steps: [step],
    });
    expect(tc1.data.testCase.sequenceNumber).toBe(1);
    expect(tc2.data.testCase.sequenceNumber).toBe(2);
  });

  test("a level's code is editable and must stay unique per tenant", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const settings = await rpc(tenant.cookie, "GET", "settings.get");
    const [levelA, levelB] = settings.data.levels;

    const renamed = await rpc(tenant.cookie, "POST", "settings.updateLevelCode", { levelId: levelA.id, code: "custom code!" });
    expect(renamed.ok).toBe(true);
    // Normalized: trimmed, uppercased, non-alphanumeric characters stripped.
    expect(renamed.data.code).toBe("CUSTOMCODE");

    const collision = await rpc(tenant.cookie, "POST", "settings.updateLevelCode", { levelId: levelB.id, code: "CUSTOMCODE" });
    expect(collision.ok).toBe(false);
    expect(collision.error?.message).toMatch(/already exists/);
  });

  test("a level's code becomes immutable once a requirement/test case has been created under it", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);

    const req = await createRequirement(tenant);
    const blockedReqLevel = await rpc(tenant.cookie, "POST", "settings.updateLevelCode", {
      levelId: req.levelId,
      code: "NEWCODE",
    });
    expect(blockedReqLevel.ok).toBe(false);
    expect(blockedReqLevel.error?.message).toMatch(/already has requirement/);

    // An unused level (nothing created under it yet) is still freely renamable.
    const levels = await rpc(tenant.cookie, "GET", "requirements.listLevels");
    const unusedLevel = levels.data.find((l: any) => l.id !== req.levelId);
    const stillAllowed = await rpc(tenant.cookie, "POST", "settings.updateLevelCode", {
      levelId: unusedLevel.id,
      code: "STILLFINE",
    });
    expect(stillAllowed.ok).toBe(true);

    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "P2" });
    const testLevel = (await rpc(tenant.cookie, "GET", "testCases.listLevels")).data[0];
    await rpc(tenant.cookie, "POST", "testCases.create", {
      productId: product.data.id,
      levelId: testLevel.id,
      customFieldValues: [await testTypeCustomFieldValue(tenant.cookie, "Verification")],
      title: "TC",
      steps: [{ description: "<p>S</p>", expectedResult: "<p>E</p>" }],
    });
    const blockedTestLevel = await rpc(tenant.cookie, "POST", "settings.updateTestLevelCode", {
      levelId: testLevel.id,
      code: "NEWTC",
    });
    expect(blockedTestLevel.ok).toBe(false);
    expect(blockedTestLevel.error?.message).toMatch(/already has test case/);
  });

  test("a code is unique across the whole tenant, not just within one kind - a requirement level and a test level can't share one", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const reqLevel = (await rpc(tenant.cookie, "GET", "requirements.listLevels")).data[0];
    const testLevel = (await rpc(tenant.cookie, "GET", "testCases.listLevels")).data[0];

    const collision = await rpc(tenant.cookie, "POST", "settings.updateTestLevelCode", {
      levelId: testLevel.id,
      code: reqLevel.code,
    });
    expect(collision.ok).toBe(false);
    expect(collision.error?.message).toMatch(/already exists/);
  });

  test("concurrent creates against the same (product, level) never produce a duplicate or skipped sequence number", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "Concurrency Test" });
    const level = (await rpc(tenant.cookie, "GET", "requirements.listLevels")).data[0];

    const concurrency = 20;
    const results = await Promise.all(
      Array.from({ length: concurrency }, (_, i) =>
        rpc(tenant.cookie, "POST", "requirements.create", {
          productId: product.data.id,
          levelId: level.id,
          title: `Concurrent requirement ${i}`,
          description: "Test description",
        }),
      ),
    );
    expect(results.every((r) => r.ok)).toBe(true);

    const numbers = results.map((r) => r.data.requirement.sequenceNumber).sort((a: number, b: number) => a - b);
    expect(numbers).toEqual(Array.from({ length: concurrency }, (_, i) => i + 1));
  });
});

describe("e2e: custom fields (backlog item 9.19)", () => {
  test("create, reorder, rename, toggle required, and delete a requirement custom field", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);

    const a = await rpc(tenant.cookie, "POST", "settings.createCustomField", {
      entityType: "requirement",
      name: "Risk Level",
      fieldType: "short_text",
    });
    expect(a.ok).toBe(true);
    expect(a.data.isRequired).toBe(false);

    const b = await rpc(tenant.cookie, "POST", "settings.createCustomField", {
      entityType: "requirement",
      name: "Owner",
      fieldType: "short_text",
      isRequired: true,
    });
    expect(b.ok).toBe(true);
    expect(b.data.isRequired).toBe(true);

    // A test-case field with the same name is unaffected - each entity type has its own
    // name-uniqueness domain.
    const tcField = await rpc(tenant.cookie, "POST", "settings.createCustomField", {
      entityType: "test_case",
      name: "Risk Level",
      fieldType: "short_text",
    });
    expect(tcField.ok).toBe(true);

    const dupe = await rpc(tenant.cookie, "POST", "settings.createCustomField", {
      entityType: "requirement",
      name: "Risk Level",
      fieldType: "integer",
    });
    expect(dupe.ok).toBe(false);
    expect(dupe.error?.message).toMatch(/already exists/);

    // "Safety Classification" leads every list here - it's pre-seeded for every tenant
    // (see packages/core/src/custom-fields.ts's seedDefaultCustomFields), sortOrder 0,
    // ahead of anything created in this test.
    let list = await rpc(tenant.cookie, "GET", "settings.listCustomFields", { entityType: "requirement" });
    expect(list.data.map((f: any) => f.name)).toEqual(["Safety Classification", "Risk Level", "Owner"]);

    const reordered = await rpc(tenant.cookie, "POST", "settings.reorderCustomField", {
      fieldId: a.data.id,
      direction: "down",
    });
    expect(reordered.ok).toBe(true);
    expect(reordered.data.map((f: any) => f.name)).toEqual(["Safety Classification", "Owner", "Risk Level"]);

    const renamed = await rpc(tenant.cookie, "POST", "settings.renameCustomField", {
      fieldId: a.data.id,
      name: "Risk Rating",
    });
    expect(renamed.ok).toBe(true);
    expect(renamed.data.name).toBe("Risk Rating");

    const toggled = await rpc(tenant.cookie, "POST", "settings.setCustomFieldRequired", {
      fieldId: a.data.id,
      isRequired: true,
    });
    expect(toggled.ok).toBe(true);
    expect(toggled.data.isRequired).toBe(true);

    const deleted = await rpc(tenant.cookie, "POST", "settings.deleteCustomField", { fieldId: b.data.id });
    expect(deleted.ok).toBe(true);
    list = await rpc(tenant.cookie, "GET", "settings.listCustomFields", { entityType: "requirement" });
    expect(list.data.map((f: any) => f.name)).toEqual(["Safety Classification", "Risk Rating"]);
  });

  test("list-type field: options can be added, renamed freely, and reordered, but not deleted while in use", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const field = await rpc(tenant.cookie, "POST", "settings.createCustomField", {
      entityType: "requirement",
      name: "Category",
      fieldType: "list",
    });

    const low = await rpc(tenant.cookie, "POST", "settings.createCustomFieldOption", { fieldId: field.data.id, value: "Low" });
    const high = await rpc(tenant.cookie, "POST", "settings.createCustomFieldOption", { fieldId: field.data.id, value: "High" });
    expect(low.ok && high.ok).toBe(true);

    const dupeOption = await rpc(tenant.cookie, "POST", "settings.createCustomFieldOption", {
      fieldId: field.data.id,
      value: "Low",
    });
    expect(dupeOption.ok).toBe(false);

    const renamed = await rpc(tenant.cookie, "POST", "settings.renameCustomFieldOption", {
      optionId: low.data.id,
      value: "Very Low",
    });
    expect(renamed.ok).toBe(true);

    // Use the (renamed) option on a real requirement, then confirm it can no longer be
    // deleted - but the untouched "High" option still can.
    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "P" });
    const level = (await rpc(tenant.cookie, "GET", "requirements.listLevels")).data[0];
    const req = await rpc(tenant.cookie, "POST", "requirements.create", {
      productId: product.data.id,
      levelId: level.id,
      title: "T",
      description: "D",
      customFieldValues: [{ fieldId: field.data.id, value: low.data.id }],
    });
    expect(req.ok).toBe(true);

    const blockedDelete = await rpc(tenant.cookie, "POST", "settings.deleteCustomFieldOption", { optionId: low.data.id });
    expect(blockedDelete.ok).toBe(false);
    expect(blockedDelete.error?.message).toMatch(/currently selected/);

    const allowedDelete = await rpc(tenant.cookie, "POST", "settings.deleteCustomFieldOption", { optionId: high.data.id });
    expect(allowedDelete.ok).toBe(true);
  });

  test("required custom fields are enforced on create, values round-trip on get/listByProduct, and update works", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const shortText = await rpc(tenant.cookie, "POST", "settings.createCustomField", {
      entityType: "requirement",
      name: "Owner",
      fieldType: "short_text",
      isRequired: true,
    });
    const integer = await rpc(tenant.cookie, "POST", "settings.createCustomField", {
      entityType: "requirement",
      name: "Story Points",
      fieldType: "integer",
    });
    const boolean = await rpc(tenant.cookie, "POST", "settings.createCustomField", {
      entityType: "requirement",
      name: "Needs Review",
      fieldType: "boolean",
    });
    const date = await rpc(tenant.cookie, "POST", "settings.createCustomField", {
      entityType: "requirement",
      name: "Due Date",
      fieldType: "date",
    });

    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "P" });
    const level = (await rpc(tenant.cookie, "GET", "requirements.listLevels")).data[0];

    // Missing the required field entirely -> rejected.
    const missingRequired = await rpc(tenant.cookie, "POST", "requirements.create", {
      productId: product.data.id,
      levelId: level.id,
      title: "T",
      description: "D",
    });
    expect(missingRequired.ok).toBe(false);
    expect(missingRequired.error?.message).toMatch(/Owner.*required/);

    // A bad integer value -> rejected with a field-specific message.
    const badInteger = await rpc(tenant.cookie, "POST", "requirements.create", {
      productId: product.data.id,
      levelId: level.id,
      title: "T",
      description: "D",
      customFieldValues: [
        { fieldId: shortText.data.id, value: "Alice" },
        { fieldId: integer.data.id, value: "not a number" },
      ],
    });
    expect(badInteger.ok).toBe(false);
    expect(badInteger.error?.message).toMatch(/Story Points/);

    const created = await rpc(tenant.cookie, "POST", "requirements.create", {
      productId: product.data.id,
      levelId: level.id,
      title: "T",
      description: "D",
      customFieldValues: [
        { fieldId: shortText.data.id, value: "Alice" },
        { fieldId: integer.data.id, value: 5 },
        { fieldId: boolean.data.id, value: true },
        { fieldId: date.data.id, value: "2026-01-15" },
      ],
    });
    expect(created.ok).toBe(true);
    const requirementId = created.data.requirement.id;

    const detail = await rpc(tenant.cookie, "GET", "requirements.get", { id: requirementId });
    const byName = (name: string) => detail.data.customFieldValues.find((v: any) => v.name === name);
    expect(byName("Owner").value).toBe("Alice");
    expect(byName("Story Points").value).toBe("5");
    expect(byName("Needs Review").value).toBe("true");
    expect(byName("Due Date").value).toBe("2026-01-15");

    const list = await rpc(tenant.cookie, "GET", "requirements.listByProduct", {
      productId: product.data.id,
      levelId: level.id,
    });
    const listedRow = list.data.find((r: any) => r.id === requirementId);
    expect(listedRow.customFieldValues.find((v: any) => v.name === "Owner").value).toBe("Alice");

    // Update: dropping the (optional) integer field clears it; the required field must
    // still be present.
    const updated = await rpc(tenant.cookie, "POST", "requirements.updateCustomFieldValues", {
      requirementId,
      values: [
        { fieldId: shortText.data.id, value: "Bob" },
        { fieldId: boolean.data.id, value: false },
      ],
    });
    expect(updated.ok).toBe(true);
    const afterUpdate = await rpc(tenant.cookie, "GET", "requirements.get", { id: requirementId });
    const byNameAfter = (name: string) => afterUpdate.data.customFieldValues.find((v: any) => v.name === name);
    expect(byNameAfter("Owner").value).toBe("Bob");
    expect(byNameAfter("Story Points").value).toBe(null);
    expect(byNameAfter("Needs Review").value).toBe("false");

    // Clearing the required field via update is rejected the same way creation is.
    const clearRequired = await rpc(tenant.cookie, "POST", "requirements.updateCustomFieldValues", {
      requirementId,
      values: [{ fieldId: boolean.data.id, value: true }],
    });
    expect(clearRequired.ok).toBe(false);
    expect(clearRequired.error?.message).toMatch(/Owner.*required/);
  });

  test("test case custom fields: create with values, round-trip on get/listByProduct, update", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const field = await rpc(tenant.cookie, "POST", "settings.createCustomField", {
      entityType: "test_case",
      name: "Automated",
      fieldType: "boolean",
    });
    const testType = await testTypeCustomFieldValue(tenant.cookie, "Verification");

    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "P" });
    const level = (await rpc(tenant.cookie, "GET", "testCases.listLevels")).data[0];
    const created = await rpc(tenant.cookie, "POST", "testCases.create", {
      productId: product.data.id,
      levelId: level.id,
      title: "TC",
      steps: [{ description: "<p>S</p>", expectedResult: "<p>E</p>" }],
      customFieldValues: [testType, { fieldId: field.data.id, value: true }],
    });
    expect(created.ok).toBe(true);
    const testCaseId = created.data.testCase.id;

    const detail = await rpc(tenant.cookie, "GET", "testCases.get", { id: testCaseId });
    expect(detail.data.customFieldValues.find((v: any) => v.name === "Automated").value).toBe("true");

    const list = await rpc(tenant.cookie, "GET", "testCases.listByProduct", {
      productId: product.data.id,
      levelId: level.id,
    });
    const listedRow = list.data.find((r: any) => r.id === testCaseId);
    expect(listedRow.customFieldValues.find((v: any) => v.name === "Automated").value).toBe("true");

    // Custom field values are folded into the same update mutation as everything else
    // now (see packages/core/src/test-cases.ts's updateTestCase docstring) - every
    // defined field is reconciled on every call, so Test Type has to be resent here too,
    // not just the field actually changing.
    const updated = await rpc(tenant.cookie, "POST", "testCases.update", {
      testCaseId,
      title: "TC",
      steps: [{ id: created.data.steps[0].id, description: "<p>S</p>", expectedResult: "<p>E</p>" }],
      customFieldValues: [testType, { fieldId: field.data.id, value: false }],
    });
    expect(updated.ok).toBe(true);
    const afterUpdate = await rpc(tenant.cookie, "GET", "testCases.get", { id: testCaseId });
    expect(afterUpdate.data.customFieldValues.find((v: any) => v.name === "Automated").value).toBe("false");
  });

  test("deleting a field definition cascades away every value set for it", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const field = await rpc(tenant.cookie, "POST", "settings.createCustomField", {
      entityType: "requirement",
      name: "Temp Field",
      fieldType: "short_text",
    });
    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "P" });
    const level = (await rpc(tenant.cookie, "GET", "requirements.listLevels")).data[0];
    const req = await rpc(tenant.cookie, "POST", "requirements.create", {
      productId: product.data.id,
      levelId: level.id,
      title: "T",
      description: "D",
      customFieldValues: [{ fieldId: field.data.id, value: "some value" }],
    });
    expect(req.ok).toBe(true);

    const deleted = await rpc(tenant.cookie, "POST", "settings.deleteCustomField", { fieldId: field.data.id });
    expect(deleted.ok).toBe(true);

    // The requirement itself is untouched - only the now-nonexistent field's value is
    // gone (there's nothing left to even ask for). "Safety Classification" is still a
    // defined field for this tenant (pre-seeded - see seedDefaultCustomFields), so it's
    // still one entry here, just unset - "Temp Field" is what's actually gone.
    const detail = await rpc(tenant.cookie, "GET", "requirements.get", { id: req.data.requirement.id });
    expect(detail.ok).toBe(true);
    expect(detail.data.customFieldValues.map((v: any) => v.name)).toEqual(["Safety Classification"]);
    expect(detail.data.customFieldValues[0].value).toBeNull();
  });
});

describe("e2e: document generation (backlog item 9.29)", () => {
  function isPdf(bytes: Uint8Array): boolean {
    return new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-";
  }

  test("a test-case-scoped template generates a real PDF, with parameter substitution", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const template = await rpc(tenant.cookie, "POST", "documentTemplates.create", {
      scope: "test_case",
      name: "TC Report",
      htmlTemplate: "<h1>{{title}}</h1><p>By {{params.preparedBy}}</p><ul>{{#each steps}}<li>{{this.description}}</li>{{/each}}</ul>",
    });
    expect(template.ok).toBe(true);
    const param = await rpc(tenant.cookie, "POST", "documentTemplates.createParameter", {
      templateId: template.data.id,
      key: "preparedBy",
      label: "Prepared by",
      type: "text",
      isRequired: true,
    });
    expect(param.ok).toBe(true);

    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "P" });
    const testLevel = (await rpc(tenant.cookie, "GET", "testCases.listLevels")).data[0];
    const testCase = await rpc(tenant.cookie, "POST", "testCases.create", {
      productId: product.data.id,
      levelId: testLevel.id,
      customFieldValues: [await testTypeCustomFieldValue(tenant.cookie, "Verification")],
      title: "TC For PDF",
      steps: [{ description: "<p>Do the thing</p>", expectedResult: "<p>It works</p>" }],
    });
    expect(testCase.ok).toBe(true);

    const missingParam = await generateDocument(tenant.cookie, {
      templateId: template.data.id,
      testCaseId: testCase.data.testCase.id,
    });
    expect(missingParam.ok).toBe(false);
    expect(missingParam.error).toMatch(/Prepared by/);

    const result = await generateDocument(tenant.cookie, {
      templateId: template.data.id,
      testCaseId: testCase.data.testCase.id,
      paramValues: { preparedBy: "E2E Tester" },
    });
    expect(result.ok).toBe(true);
    expect(result.contentType).toBe("application/pdf");
    expect(result.contentDisposition).toContain("TC Report.pdf");
    expect(isPdf(result.bytes)).toBe(true);
    expect(result.bytes.length).toBeGreaterThan(100);
  });

  test("a test-execution-scoped template generates a PDF including recorded results", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const template = await rpc(tenant.cookie, "POST", "documentTemplates.create", {
      scope: "test_execution",
      name: "Execution Report",
      htmlTemplate: "<h1>{{testCase.title}}</h1><p>{{status}}</p>{{#each steps}}<p>{{this.actualResult}}</p>{{/each}}",
    });
    expect(template.ok).toBe(true);

    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "P" });
    const testLevel = (await rpc(tenant.cookie, "GET", "testCases.listLevels")).data[0];
    const environment = (await rpc(tenant.cookie, "GET", "testCases.listEnvironments")).data[0];
    const testCase = await rpc(tenant.cookie, "POST", "testCases.create", {
      productId: product.data.id,
      levelId: testLevel.id,
      customFieldValues: [await testTypeCustomFieldValue(tenant.cookie, "Verification")],
      title: "TC",
      steps: [{ description: "<p>S</p>", expectedResult: "<p>E</p>" }],
    });
    const execution = await rpc(tenant.cookie, "POST", "testCases.startExecution", {
      testCaseId: testCase.data.testCase.id,
      environmentId: environment.id,
    });
    await rpc(tenant.cookie, "POST", "testCases.recordStepResult", {
      testStepExecutionId: execution.data.stepExecutions[0].id,
      actualResult: "<p>Worked fine</p>",
      status: "pass",
    });

    const result = await generateDocument(tenant.cookie, { templateId: template.data.id, executionId: execution.data.execution.id });
    expect(result.ok).toBe(true);
    expect(isPdf(result.bytes)).toBe(true);
  });

  test("a requirement-list-scoped template generates a PDF for exactly the requirement ids passed", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const template = await rpc(tenant.cookie, "POST", "documentTemplates.create", {
      scope: "requirement_list",
      name: "Spec",
      htmlTemplate: "<h1>{{productName}} - {{levelName}}</h1>{{#each requirements}}<h2>{{this.displayId}}: {{this.title}}</h2>{{/each}}",
    });
    expect(template.ok).toBe(true);

    const { productId, requirementId: reqA } = await createRequirement(tenant);
    const b = await createRequirement(tenant, { productId });

    const result = await generateDocument(tenant.cookie, {
      templateId: template.data.id,
      requirementIds: [reqA, b.requirementId],
      productId,
      levelId: b.levelId,
    });
    expect(result.ok).toBe(true);
    expect(isPdf(result.bytes)).toBe(true);

    const missingId = await generateDocument(tenant.cookie, {
      templateId: template.data.id,
      requirementIds: [reqA, "00000000-0000-0000-0000-000000000000"],
      productId,
      levelId: b.levelId,
    });
    expect(missingId.ok).toBe(false);
    expect(missingId.error).toMatch(/could not be found/);
  });

  test("template CRUD: create, rename, update HTML, and delete cascades its parameters", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const created = await rpc(tenant.cookie, "POST", "documentTemplates.create", {
      scope: "test_case",
      name: "Draft",
      htmlTemplate: "<p>v1</p>",
    });
    expect(created.ok).toBe(true);

    const renamed = await rpc(tenant.cookie, "POST", "documentTemplates.rename", { id: created.data.id, name: "Final" });
    expect(renamed.ok).toBe(true);
    expect(renamed.data.name).toBe("Final");

    const updated = await rpc(tenant.cookie, "POST", "documentTemplates.updateHtml", { id: created.data.id, htmlTemplate: "<p>v2</p>" });
    expect(updated.ok).toBe(true);
    expect(updated.data.htmlTemplate).toBe("<p>v2</p>");

    await rpc(tenant.cookie, "POST", "documentTemplates.createParameter", {
      templateId: created.data.id,
      key: "note",
      label: "Note",
      type: "text",
    });

    const deleted = await rpc(tenant.cookie, "POST", "documentTemplates.delete", { id: created.data.id });
    expect(deleted.ok).toBe(true);

    const afterDelete = await rpc(tenant.cookie, "GET", "documentTemplates.get", { id: created.data.id });
    expect(afterDelete.ok).toBe(false);
    expect(afterDelete.status).toBe(404);
  });

  test("a duplicate parameter key on the same template is rejected", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const template = await rpc(tenant.cookie, "POST", "documentTemplates.create", {
      scope: "test_case",
      name: "T",
      htmlTemplate: "<p>x</p>",
    });
    const first = await rpc(tenant.cookie, "POST", "documentTemplates.createParameter", {
      templateId: template.data.id,
      key: "who",
      label: "Who",
      type: "text",
    });
    expect(first.ok).toBe(true);
    const dup = await rpc(tenant.cookie, "POST", "documentTemplates.createParameter", {
      templateId: template.data.id,
      key: "who",
      label: "Who Again",
      type: "text",
    });
    expect(dup.ok).toBe(false);
    expect(dup.error?.message).toMatch(/already exists/);
  });

  test("RLS: one tenant cannot generate a document from another tenant's template", async () => {
    const tenantA = await registerTenant(`E2E Org A ${uniqueSuffix()}`);
    const tenantB = await registerTenant(`E2E Org B ${uniqueSuffix()}`);
    const template = await rpc(tenantB.cookie, "POST", "documentTemplates.create", {
      scope: "test_case",
      name: "B's template",
      htmlTemplate: "<p>{{title}}</p>",
    });
    const product = await rpc(tenantA.cookie, "POST", "products.create", { name: "P" });
    const testLevel = (await rpc(tenantA.cookie, "GET", "testCases.listLevels")).data[0];
    const testCase = await rpc(tenantA.cookie, "POST", "testCases.create", {
      productId: product.data.id,
      levelId: testLevel.id,
      customFieldValues: [await testTypeCustomFieldValue(tenantA.cookie, "Verification")],
      title: "TC",
      steps: [{ description: "<p>S</p>", expectedResult: "<p>E</p>" }],
    });

    const result = await generateDocument(tenantA.cookie, {
      templateId: template.data.id,
      testCaseId: testCase.data.testCase.id,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
  });

  test("generating without a session is unauthorized", async () => {
    const res = await fetch(`${BASE_URL}/api/documents/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId: "00000000-0000-0000-0000-000000000000" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("e2e: live template preview (backlog item 9.30)", () => {
  test("previewing with no example selected returns no html and no error", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const template = await rpc(tenant.cookie, "POST", "documentTemplates.create", {
      scope: "test_case",
      name: "T",
      htmlTemplate: "<h1>{{title}}</h1>",
    });
    const preview = await rpc(tenant.cookie, "POST", "documentTemplates.previewHtml", {
      templateId: template.data.id,
      htmlTemplate: "<h1>{{title}}</h1>",
    });
    expect(preview.ok).toBe(true);
    expect(preview.data.html).toBeNull();
    expect(preview.data.error).toBeNull();
  });

  test("preview renders the current (unsaved) draft, not the last-saved template, wrapped as a full document", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const template = await rpc(tenant.cookie, "POST", "documentTemplates.create", {
      scope: "test_case",
      name: "T",
      htmlTemplate: "<h1>SAVED VERSION</h1>",
    });
    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "P" });
    const testLevel = (await rpc(tenant.cookie, "GET", "testCases.listLevels")).data[0];
    const testCase = await rpc(tenant.cookie, "POST", "testCases.create", {
      productId: product.data.id,
      levelId: testLevel.id,
      customFieldValues: [await testTypeCustomFieldValue(tenant.cookie, "Verification")],
      title: "Preview Me",
      steps: [{ description: "<p>S</p>", expectedResult: "<p>E</p>" }],
    });

    const preview = await rpc(tenant.cookie, "POST", "documentTemplates.previewHtml", {
      templateId: template.data.id,
      htmlTemplate: "<h2>DRAFT VERSION {{title}}</h2>",
      testCaseId: testCase.data.testCase.id,
    });
    expect(preview.ok).toBe(true);
    expect(preview.data.html).toContain("DRAFT VERSION Preview Me");
    expect(preview.data.html).not.toContain("SAVED VERSION");
    // ensureHtmlDocument wraps a body-fragment template in a full document skeleton.
    expect(preview.data.html).toContain("<html>");
    expect(preview.data.html).toContain("<!DOCTYPE html>");
  });

  test("preview substitutes a filled-in parameter and leaves an unfilled one blank, without erroring", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const template = await rpc(tenant.cookie, "POST", "documentTemplates.create", {
      scope: "test_case",
      name: "T",
      htmlTemplate: "<p>By {{params.preparedBy}} - {{params.other}}</p>",
    });
    await rpc(tenant.cookie, "POST", "documentTemplates.createParameter", {
      templateId: template.data.id,
      key: "preparedBy",
      label: "Prepared by",
      type: "text",
      isRequired: true,
    });
    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "P" });
    const testLevel = (await rpc(tenant.cookie, "GET", "testCases.listLevels")).data[0];
    const testCase = await rpc(tenant.cookie, "POST", "testCases.create", {
      productId: product.data.id,
      levelId: testLevel.id,
      customFieldValues: [await testTypeCustomFieldValue(tenant.cookie, "Verification")],
      title: "TC",
      steps: [{ description: "<p>S</p>", expectedResult: "<p>E</p>" }],
    });

    // No paramValues at all - unlike the real generate route, a missing *required*
    // parameter must not fail the whole preview.
    const preview = await rpc(tenant.cookie, "POST", "documentTemplates.previewHtml", {
      templateId: template.data.id,
      htmlTemplate: "<p>By {{params.preparedBy}} - {{params.other}}</p>",
      testCaseId: testCase.data.testCase.id,
    });
    expect(preview.ok).toBe(true);
    expect(preview.data.error).toBeNull();
    expect(preview.data.html).toContain("<p>By  - </p>");

    const filledIn = await rpc(tenant.cookie, "POST", "documentTemplates.previewHtml", {
      templateId: template.data.id,
      htmlTemplate: "<p>By {{params.preparedBy}} - {{params.other}}</p>",
      testCaseId: testCase.data.testCase.id,
      paramValues: { preparedBy: "E2E Tester" },
    });
    expect(filledIn.data.html).toContain("<p>By E2E Tester - </p>");
  });

  test("preview works for the test-execution and requirement-list scopes too", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "P" });
    const testLevel = (await rpc(tenant.cookie, "GET", "testCases.listLevels")).data[0];
    const environment = (await rpc(tenant.cookie, "GET", "testCases.listEnvironments")).data[0];
    const testCase = await rpc(tenant.cookie, "POST", "testCases.create", {
      productId: product.data.id,
      levelId: testLevel.id,
      customFieldValues: [await testTypeCustomFieldValue(tenant.cookie, "Verification")],
      title: "TC",
      steps: [{ description: "<p>S</p>", expectedResult: "<p>E</p>" }],
    });
    const execution = await rpc(tenant.cookie, "POST", "testCases.startExecution", {
      testCaseId: testCase.data.testCase.id,
      environmentId: environment.id,
    });
    const executionTemplate = await rpc(tenant.cookie, "POST", "documentTemplates.create", {
      scope: "test_execution",
      name: "ExecT",
      htmlTemplate: "<p>{{status}}</p>",
    });
    const executionPreview = await rpc(tenant.cookie, "POST", "documentTemplates.previewHtml", {
      templateId: executionTemplate.data.id,
      htmlTemplate: "<p>{{status}}</p>",
      executionId: execution.data.execution.id,
    });
    expect(executionPreview.data.html).toContain("in_progress");

    const { productId, requirementId } = await createRequirement(tenant);
    const reqLevel = (await rpc(tenant.cookie, "GET", "requirements.listLevels")).data[0];
    const listTemplate = await rpc(tenant.cookie, "POST", "documentTemplates.create", {
      scope: "requirement_list",
      name: "ListT",
      htmlTemplate: "{{#each requirements}}<p>{{this.title}}</p>{{/each}}",
    });
    const listPreview = await rpc(tenant.cookie, "POST", "documentTemplates.previewHtml", {
      templateId: listTemplate.data.id,
      htmlTemplate: "{{#each requirements}}<p>{{this.title}}</p>{{/each}}",
      requirementIds: [requirementId],
      productId,
      levelId: reqLevel.id,
    });
    expect(listPreview.data.html).toContain("Test requirement");
  });

  test("listExampleTestCases and listExampleExecutions surface real, existing rows", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "P" });
    const testLevel = (await rpc(tenant.cookie, "GET", "testCases.listLevels")).data[0];
    const environment = (await rpc(tenant.cookie, "GET", "testCases.listEnvironments")).data[0];
    const testCase = await rpc(tenant.cookie, "POST", "testCases.create", {
      productId: product.data.id,
      levelId: testLevel.id,
      customFieldValues: [await testTypeCustomFieldValue(tenant.cookie, "Verification")],
      title: "Example TC",
      steps: [{ description: "<p>S</p>", expectedResult: "<p>E</p>" }],
    });
    const execution = await rpc(tenant.cookie, "POST", "testCases.startExecution", {
      testCaseId: testCase.data.testCase.id,
      environmentId: environment.id,
    });

    const tcList = await rpc(tenant.cookie, "GET", "documentTemplates.listExampleTestCases");
    expect(tcList.ok).toBe(true);
    expect(tcList.data.some((t: any) => t.id === testCase.data.testCase.id && t.title === "Example TC")).toBe(true);

    const exList = await rpc(tenant.cookie, "GET", "documentTemplates.listExampleExecutions");
    expect(exList.ok).toBe(true);
    expect(exList.data.some((e: any) => e.id === execution.data.execution.id)).toBe(true);
  });

  test("RLS: preview only sees this tenant's own test cases/executions as examples", async () => {
    const tenantA = await registerTenant(`E2E Org A ${uniqueSuffix()}`);
    const tenantB = await registerTenant(`E2E Org B ${uniqueSuffix()}`);
    const product = await rpc(tenantB.cookie, "POST", "products.create", { name: "P" });
    const testLevel = (await rpc(tenantB.cookie, "GET", "testCases.listLevels")).data[0];
    const testCase = await rpc(tenantB.cookie, "POST", "testCases.create", {
      productId: product.data.id,
      levelId: testLevel.id,
      customFieldValues: [await testTypeCustomFieldValue(tenantB.cookie, "Verification")],
      title: "B's TC",
      steps: [{ description: "<p>S</p>", expectedResult: "<p>E</p>" }],
    });

    const tcList = await rpc(tenantA.cookie, "GET", "documentTemplates.listExampleTestCases");
    expect(tcList.data.some((t: any) => t.id === testCase.data.testCase.id)).toBe(false);
  });
});

describe("e2e: filename templates and bulk generation (backlog items 9.31/9.32)", () => {
  test("a template's filenameTemplate is rendered and sanitized into Content-Disposition", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const template = await rpc(tenant.cookie, "POST", "documentTemplates.create", {
      scope: "test_case",
      name: "T",
      htmlTemplate: "<p>{{title}}</p>",
      filenameTemplate: "{{displayId}} - {{title}}",
    });
    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "P" });
    const testLevel = (await rpc(tenant.cookie, "GET", "testCases.listLevels")).data[0];
    const testCase = await rpc(tenant.cookie, "POST", "testCases.create", {
      productId: product.data.id,
      levelId: testLevel.id,
      customFieldValues: [await testTypeCustomFieldValue(tenant.cookie, "Verification")],
      title: "Login / Logout",
      steps: [{ description: "<p>S</p>", expectedResult: "<p>E</p>" }],
    });

    const result = await generateDocument(tenant.cookie, { templateId: template.data.id, testCaseId: testCase.data.testCase.id });
    expect(result.ok).toBe(true);
    // "/" is filesystem-illegal and gets stripped to "_" by renderFilename.
    expect(result.contentDisposition).toContain("TC-1 - Login _ Logout.pdf");
  });

  test("an unset filenameTemplate falls back to the template's own name", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const template = await rpc(tenant.cookie, "POST", "documentTemplates.create", {
      scope: "test_case",
      name: "Fallback Name",
      htmlTemplate: "<p>{{title}}</p>",
    });
    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "P" });
    const testLevel = (await rpc(tenant.cookie, "GET", "testCases.listLevels")).data[0];
    const testCase = await rpc(tenant.cookie, "POST", "testCases.create", {
      productId: product.data.id,
      levelId: testLevel.id,
      customFieldValues: [await testTypeCustomFieldValue(tenant.cookie, "Verification")],
      title: "TC",
      steps: [{ description: "<p>S</p>", expectedResult: "<p>E</p>" }],
    });

    const result = await generateDocument(tenant.cookie, { templateId: template.data.id, testCaseId: testCase.data.testCase.id });
    expect(result.contentDisposition).toContain("Fallback Name.pdf");
  });

  test("updateFilename sets and clears the filename template", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const template = await rpc(tenant.cookie, "POST", "documentTemplates.create", {
      scope: "test_case",
      name: "T",
      htmlTemplate: "<p>x</p>",
    });
    const set = await rpc(tenant.cookie, "POST", "documentTemplates.updateFilename", {
      id: template.data.id,
      filenameTemplate: "{{displayId}}",
    });
    expect(set.ok).toBe(true);
    expect(set.data.filenameTemplate).toBe("{{displayId}}");

    const cleared = await rpc(tenant.cookie, "POST", "documentTemplates.updateFilename", {
      id: template.data.id,
      filenameTemplate: "   ",
    });
    expect(cleared.data.filenameTemplate).toBeNull();
  });

  test("bulk-generating for several test cases returns one real, distinctly-named zip entry per test case", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const template = await rpc(tenant.cookie, "POST", "documentTemplates.create", {
      scope: "test_case",
      name: "T",
      htmlTemplate: "<h1>{{title}}</h1>",
      filenameTemplate: "{{displayId}} - {{title}}",
    });
    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "P" });
    const testLevel = (await rpc(tenant.cookie, "GET", "testCases.listLevels")).data[0];
    const step = { description: "<p>S</p>", expectedResult: "<p>E</p>" };
    const tc1 = await rpc(tenant.cookie, "POST", "testCases.create", {
      productId: product.data.id,
      levelId: testLevel.id,
      customFieldValues: [await testTypeCustomFieldValue(tenant.cookie, "Verification")],
      title: "First",
      steps: [step],
    });
    const tc2 = await rpc(tenant.cookie, "POST", "testCases.create", {
      productId: product.data.id,
      levelId: testLevel.id,
      customFieldValues: [await testTypeCustomFieldValue(tenant.cookie, "Verification")],
      title: "Second",
      steps: [step],
    });

    const result = await generateBulkDocument(tenant.cookie, {
      templateId: template.data.id,
      testCaseIds: [tc1.data.testCase.id, tc2.data.testCase.id],
    });
    expect(result.ok).toBe(true);
    // Real progress, not just a final result - one event per completed target, ending
    // exactly at the total.
    expect(result.progressEvents).toEqual([
      { done: 1, total: 2 },
      { done: 2, total: 2 },
    ]);
    const names = zipEntryNames(result.zipBytes!);
    expect(names.sort()).toEqual(["TC-1 - First.pdf", "TC-2 - Second.pdf"]);
  });

  test("bulk-generating for several executions works the same way", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const template = await rpc(tenant.cookie, "POST", "documentTemplates.create", {
      scope: "test_execution",
      name: "ExecT",
      htmlTemplate: "<p>{{status}}</p>",
      filenameTemplate: "{{testCase.displayId}} run",
    });
    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "P" });
    const testLevel = (await rpc(tenant.cookie, "GET", "testCases.listLevels")).data[0];
    const environment = (await rpc(tenant.cookie, "GET", "testCases.listEnvironments")).data[0];
    const testCase = await rpc(tenant.cookie, "POST", "testCases.create", {
      productId: product.data.id,
      levelId: testLevel.id,
      customFieldValues: [await testTypeCustomFieldValue(tenant.cookie, "Verification")],
      title: "TC",
      steps: [{ description: "<p>S</p>", expectedResult: "<p>E</p>" }],
    });
    const ex1 = await rpc(tenant.cookie, "POST", "testCases.startExecution", {
      testCaseId: testCase.data.testCase.id,
      environmentId: environment.id,
    });
    const ex2 = await rpc(tenant.cookie, "POST", "testCases.startExecution", {
      testCaseId: testCase.data.testCase.id,
      environmentId: environment.id,
    });

    const result = await generateBulkDocument(tenant.cookie, {
      templateId: template.data.id,
      executionIds: [ex1.data.execution.id, ex2.data.execution.id],
    });
    expect(result.ok).toBe(true);
    // Both executions render to the same filename template ("TC-1 run") - the second
    // must be disambiguated, not silently overwrite the first inside the zip.
    const names = zipEntryNames(result.zipBytes!);
    expect(names.length).toBe(2);
    expect(names).toContain("TC-1 run.pdf");
    expect(names.some((n) => n === "TC-1 run (2).pdf")).toBe(true);
  });

  test("a bulk run that partially fails still returns a zip with the successes plus errors.txt", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const template = await rpc(tenant.cookie, "POST", "documentTemplates.create", {
      scope: "test_case",
      name: "T",
      htmlTemplate: "<p>{{title}}</p>",
    });
    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "P" });
    const testLevel = (await rpc(tenant.cookie, "GET", "testCases.listLevels")).data[0];
    const testCase = await rpc(tenant.cookie, "POST", "testCases.create", {
      productId: product.data.id,
      levelId: testLevel.id,
      customFieldValues: [await testTypeCustomFieldValue(tenant.cookie, "Verification")],
      title: "Real One",
      steps: [{ description: "<p>S</p>", expectedResult: "<p>E</p>" }],
    });

    const result = await generateBulkDocument(tenant.cookie, {
      templateId: template.data.id,
      testCaseIds: [testCase.data.testCase.id, "00000000-0000-0000-0000-000000000000"],
    });
    expect(result.ok).toBe(true);
    const names = zipEntryNames(result.zipBytes!);
    expect(names).toContain("errors.txt");
    expect(names).toContain("T.pdf");
  });

  test("a bulk run where every target fails returns an error line, not a broken zip", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const template = await rpc(tenant.cookie, "POST", "documentTemplates.create", {
      scope: "test_case",
      name: "T",
      htmlTemplate: "<p>{{title}}</p>",
    });
    const result = await generateBulkDocument(tenant.cookie, {
      templateId: template.data.id,
      testCaseIds: ["00000000-0000-0000-0000-000000000000"],
    });
    expect(result.ok).toBe(false);
    expect(result.zipBytes).toBeUndefined();
    expect(result.error).toMatch(/every selected item failed/);
    // The one target still counted as "done" in the progress stream before the final
    // error line - the operator watching the progress bar sees it reach the end, not
    // just hang.
    expect(result.progressEvents).toEqual([{ done: 1, total: 1 }]);
  });

  test("passing the wrong id array for a template's scope is refused with a clear message", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const template = await rpc(tenant.cookie, "POST", "documentTemplates.create", {
      scope: "test_case",
      name: "T",
      htmlTemplate: "<p>x</p>",
    });
    const result = await generateBulkDocument(tenant.cookie, {
      templateId: template.data.id,
      executionIds: ["00000000-0000-0000-0000-000000000000"],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/test case template/);
  });

  test("a requirement-list template is refused for bulk generation", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const template = await rpc(tenant.cookie, "POST", "documentTemplates.create", {
      scope: "requirement_list",
      name: "T",
      htmlTemplate: "<p>x</p>",
    });
    const result = await generateBulkDocument(tenant.cookie, {
      templateId: template.data.id,
      testCaseIds: ["00000000-0000-0000-0000-000000000000"],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/test case and test execution/);
  });

  test("more than the bulk limit is refused before any generation work happens", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const template = await rpc(tenant.cookie, "POST", "documentTemplates.create", {
      scope: "test_case",
      name: "T",
      htmlTemplate: "<p>x</p>",
    });
    const tooMany = Array.from({ length: 101 }, () => "00000000-0000-0000-0000-000000000000");
    const result = await generateBulkDocument(tenant.cookie, { templateId: template.data.id, testCaseIds: tooMany });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/too many/);
  });

  test("RLS: a bulk request can't pull in another tenant's test case - it's reported as a per-item failure", async () => {
    const tenantA = await registerTenant(`E2E Org A ${uniqueSuffix()}`);
    const tenantB = await registerTenant(`E2E Org B ${uniqueSuffix()}`);
    const productB = await rpc(tenantB.cookie, "POST", "products.create", { name: "P" });
    const testLevelB = (await rpc(tenantB.cookie, "GET", "testCases.listLevels")).data[0];
    const testCaseB = await rpc(tenantB.cookie, "POST", "testCases.create", {
      productId: productB.data.id,
      levelId: testLevelB.id,
      customFieldValues: [await testTypeCustomFieldValue(tenantB.cookie, "Verification")],
      title: "B's TC",
      steps: [{ description: "<p>S</p>", expectedResult: "<p>E</p>" }],
    });
    const templateA = await rpc(tenantA.cookie, "POST", "documentTemplates.create", {
      scope: "test_case",
      name: "T",
      htmlTemplate: "<p>{{title}}</p>",
    });

    const result = await generateBulkDocument(tenantA.cookie, {
      templateId: templateA.data.id,
      testCaseIds: [testCaseB.data.testCase.id],
    });
    // The only target was cross-tenant, so every target failed - an in-stream error
    // line, not a zip that somehow contains tenant B's test case.
    expect(result.ok).toBe(false);
    expect(result.zipBytes).toBeUndefined();
  });
});

describe("e2e: AI-assisted test step drafting (backlog item 9.37)", () => {
  // A real connection can never legitimately have this base URL - it's the one and only
  // trigger for resolveModel's test-only fake model (see packages/integrations/llm/src/
  // resolve-model.ts), and only fires when ALLOW_MOCK_LLM_PROVIDER=1 is also set in the
  // running stack's environment (see .env - dev/CI only). Lets this whole feature be
  // exercised over real HTTP against the real DB without ever calling a real, paid LLM.
  const MOCK_BASE_URL = "mock://step-suggestions";

  async function saveMockConnection(tenant: TestTenant) {
    const res = await rpc(tenant.cookie, "POST", "llm.saveConnection", {
      provider: "openai_compatible",
      model: "mock-model",
      baseUrl: MOCK_BASE_URL,
      apiKey: "dummy-key-for-testing",
    });
    expect(res.ok).toBe(true);
  }

  test("no connection saved yet: getConnection is null and suggestSteps returns an error, not a thrown one", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const got = await rpc(tenant.cookie, "GET", "llm.getConnection");
    expect(got.data).toBeNull();

    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "P" });
    const result = await rpc(tenant.cookie, "POST", "testCases.suggestSteps", {
      productId: product.data.id,
      originalSteps: [],
      history: [],
      instruction: "draft a step",
    });
    expect(result.ok).toBe(true);
    expect(result.data.error).toContain("no AI connection saved yet");
    expect(result.data.upserts).toBeUndefined();
  });

  test("saving a connection never echoes the API key back, and an empty key on re-save keeps the existing one", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    await saveMockConnection(tenant);

    const first = await rpc(tenant.cookie, "GET", "llm.getConnection");
    expect(first.data).toMatchObject({ provider: "openai_compatible", model: "mock-model", baseUrl: MOCK_BASE_URL, hasApiKey: true });
    expect(first.data.apiKey).toBeUndefined();

    // Re-save with a different model and no apiKey - should keep the previously-saved key
    // (verified indirectly: the connection still works afterward, in the next test) rather
    // than fail with "an API key is required".
    const resaved = await rpc(tenant.cookie, "POST", "llm.saveConnection", {
      provider: "openai_compatible",
      model: "mock-model-v2",
      baseUrl: MOCK_BASE_URL,
    });
    expect(resaved.ok).toBe(true);

    const second = await rpc(tenant.cookie, "GET", "llm.getConnection");
    expect(second.data.model).toBe("mock-model-v2");
    expect(second.data.hasApiKey).toBe(true);
  });

  test("testConnection succeeds against the mock provider", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    await saveMockConnection(tenant);
    const result = await rpc(tenant.cookie, "POST", "llm.testConnection");
    expect(result.ok).toBe(true);
    expect(result.data.ok).toBe(true);
  });

  test("suggestSteps against the mock connection returns a well-shaped proposal and persists nothing", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    await saveMockConnection(tenant);
    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "P" });
    const testLevel = (await rpc(tenant.cookie, "GET", "testCases.listLevels")).data[0];
    const testCase = await rpc(tenant.cookie, "POST", "testCases.create", {
      productId: product.data.id,
      levelId: testLevel.id,
      customFieldValues: [await testTypeCustomFieldValue(tenant.cookie, "Verification")],
      title: "TC",
      steps: [{ description: "<p>Existing step</p>", expectedResult: "<p>OK</p>" }],
    });
    const testCaseId = testCase.data.testCase.id;

    const sql = new SQL(PG_SUPERUSER_URL);
    const [{ count: beforeCount }] = await sql`select count(*)::int as count from test_steps where test_case_id = ${testCaseId}`;

    const result = await rpc(tenant.cookie, "POST", "testCases.suggestSteps", {
      productId: product.data.id,
      testCaseTitle: "TC",
      originalSteps: testCase.data.steps.map((s: any) => ({
        key: s.id,
        description: s.description,
        expectedResult: s.expectedResult,
        purpose: s.purpose ?? undefined,
        requirementIds: [],
      })),
      history: [],
      instruction: "add a step",
    });
    expect(result.ok).toBe(true);
    expect(result.data.error).toBeUndefined();
    expect(typeof result.data.summary).toBe("string");
    expect(Array.isArray(result.data.upserts)).toBe(true);
    expect(result.data.upserts.length).toBeGreaterThan(0);
    expect(Array.isArray(result.data.removedKeys)).toBe(true);
    // Delta, not a full list - "add a step" with two pre-existing untouched steps must
    // not re-list either of them.
    expect(result.data.upserts.length).toBe(1);
    for (const step of result.data.upserts) {
      expect(typeof step.description).toBe("string");
      expect(typeof step.expectedResult).toBe("string");
    }

    const [{ count: afterCount }] = await sql`select count(*)::int as count from test_steps where test_case_id = ${testCaseId}`;
    await sql.close();
    // This mutation only ever stages a proposal client-side - it must never write to
    // test_steps itself, regardless of what the model returns.
    expect(afterCount).toBe(beforeCount);
  });

  test("a mock-triggered failure comes back as an error field, never an HTTP 500", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    await saveMockConnection(tenant);
    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "P" });

    const result = await rpc(tenant.cookie, "POST", "testCases.suggestSteps", {
      productId: product.data.id,
      originalSteps: [],
      history: [],
      instruction: "__mock_force_error__ please fail",
    });
    expect(result.status).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.data.error).toBeTruthy();
    expect(result.data.upserts).toBeUndefined();
  });

  test("the mock's __mock_modify_step__ branch echoes the real step's key with new content, for a genuine 'modified' diff row", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    await saveMockConnection(tenant);
    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "P" });
    const testLevel = (await rpc(tenant.cookie, "GET", "testCases.listLevels")).data[0];
    const testCase = await rpc(tenant.cookie, "POST", "testCases.create", {
      productId: product.data.id,
      levelId: testLevel.id,
      customFieldValues: [await testTypeCustomFieldValue(tenant.cookie, "Verification")],
      title: "TC",
      steps: [{ description: "<p>Original step</p>", expectedResult: "<p>Original result</p>" }],
    });
    const originalStepId = testCase.data.steps[0].id;

    const result = await rpc(tenant.cookie, "POST", "testCases.suggestSteps", {
      productId: product.data.id,
      originalSteps: testCase.data.steps.map((s: any) => ({
        key: s.id,
        description: s.description,
        expectedResult: s.expectedResult,
      })),
      history: [],
      instruction: "__mock_modify_step__ please reword the first step",
    });
    expect(result.ok).toBe(true);
    expect(result.data.error).toBeUndefined();
    // Same key as the original step - this is what makes diffProposedSteps classify it
    // as "modified" (matched key, different content), not "added" (unmatched key).
    const modified = result.data.upserts.find((s: any) => s.key === originalStepId);
    expect(modified).toBeDefined();
    expect(modified.description).not.toBe("<p>Original step</p>");
    // Atomic - a modify instruction only modifies, it doesn't also silently add an
    // unrelated step (see resolve-model.ts's mock docstring on why branches are
    // mutually exclusive since the delta redesign, backlog item 9.42).
    expect(result.data.upserts).toHaveLength(1);
    expect(result.data.removedKeys).toEqual([]);
  });

  test("the mock's __mock_remove_step__ branch puts the real step's key in removedKeys, not in upserts - a genuine delta removal", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    await saveMockConnection(tenant);
    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "P" });
    const testLevel = (await rpc(tenant.cookie, "GET", "testCases.listLevels")).data[0];
    const testCase = await rpc(tenant.cookie, "POST", "testCases.create", {
      productId: product.data.id,
      levelId: testLevel.id,
      customFieldValues: [await testTypeCustomFieldValue(tenant.cookie, "Verification")],
      title: "TC",
      steps: [{ description: "<p>Step to remove</p>", expectedResult: "<p>OK</p>" }],
    });
    const originalStepId = testCase.data.steps[0].id;

    const result = await rpc(tenant.cookie, "POST", "testCases.suggestSteps", {
      productId: product.data.id,
      originalSteps: testCase.data.steps.map((s: any) => ({
        key: s.id,
        description: s.description,
        expectedResult: s.expectedResult,
      })),
      history: [],
      instruction: "__mock_remove_step__ please drop the redundant step",
    });
    expect(result.ok).toBe(true);
    expect(result.data.error).toBeUndefined();
    expect(result.data.removedKeys).toEqual([originalStepId]);
    // The removed step's real key must not also show up as something to upsert - a
    // step is either removed or changed, never both in the same response. Also atomic
    // in the other direction: a remove instruction doesn't also silently add a step.
    expect(result.data.upserts.some((s: any) => s.key === originalStepId)).toBe(false);
    expect(result.data.upserts).toEqual([]);
  });

  test("the mock's __mock_typo_fix__ branch echoes real content with a small change, for a genuinely character-level diff (backlog item 9.47)", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    await saveMockConnection(tenant);
    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "P" });
    const testLevel = (await rpc(tenant.cookie, "GET", "testCases.listLevels")).data[0];
    const testCase = await rpc(tenant.cookie, "POST", "testCases.create", {
      productId: product.data.id,
      levelId: testLevel.id,
      customFieldValues: [await testTypeCustomFieldValue(tenant.cookie, "Verification")],
      title: "TC",
      steps: [{ description: "<p>Enter valid credentials</p>", expectedResult: "<p>Login succeeds</p>" }],
    });
    const originalStepId = testCase.data.steps[0].id;

    const result = await rpc(tenant.cookie, "POST", "testCases.suggestSteps", {
      productId: product.data.id,
      originalSteps: testCase.data.steps.map((s: any) => ({
        key: s.id,
        description: s.description,
        expectedResult: s.expectedResult,
      })),
      history: [],
      instruction: "__mock_typo_fix__ please tighten the wording slightly",
    });
    expect(result.ok).toBe(true);
    expect(result.data.error).toBeUndefined();
    const modified = result.data.upserts.find((s: any) => s.key === originalStepId);
    expect(modified).toBeDefined();
    // Real original text, plus a small appended suffix - not swapped wholesale (that's
    // what __mock_modify_step__ is for) - so a real client-side character diff against
    // the original has something small and specific to highlight, not one giant
    // removed+added chunk.
    expect(modified.description).toBe("<p>Enter valid credentials</p> (reviewed)");
    expect(modified.description.startsWith(testCase.data.steps[0].description)).toBe(true);
    // expectedResult was echoed back completely unchanged.
    expect(modified.expectedResult).toBe("<p>Login succeeds</p>");
  });

  test("the mock's __mock_insert_middle__ branch positions a new step via `order`, not just appended at the end (backlog item 9.43)", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    await saveMockConnection(tenant);
    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "P" });
    const testLevel = (await rpc(tenant.cookie, "GET", "testCases.listLevels")).data[0];
    const testCase = await rpc(tenant.cookie, "POST", "testCases.create", {
      productId: product.data.id,
      levelId: testLevel.id,
      customFieldValues: [await testTypeCustomFieldValue(tenant.cookie, "Verification")],
      title: "TC",
      steps: [
        { description: "<p>Step one</p>", expectedResult: "<p>OK</p>" },
        { description: "<p>Step two</p>", expectedResult: "<p>OK</p>" },
        { description: "<p>Step three</p>", expectedResult: "<p>OK</p>" },
      ],
    });
    const [step1, step2, step3] = testCase.data.steps.map((s: any) => s.id);

    const result = await rpc(tenant.cookie, "POST", "testCases.suggestSteps", {
      productId: product.data.id,
      originalSteps: testCase.data.steps.map((s: any) => ({
        key: s.id,
        description: s.description,
        expectedResult: s.expectedResult,
      })),
      history: [],
      instruction: "__mock_insert_middle__ please add a step right after the first one",
    });
    expect(result.ok).toBe(true);
    expect(result.data.error).toBeUndefined();
    expect(result.data.upserts).toHaveLength(1);
    expect(result.data.upserts[0].key).toBeNull();
    // `order` places a null (the new step) right after step one, then the rest of the
    // original steps in their original order - not the new step appended at the end.
    expect(result.data.order).toEqual([step1, null, step2, step3]);
  });

  test("a hallucinated requirementId the mock returns never reaches the client - filtered server-side (backlog item 9.44)", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    await saveMockConnection(tenant);
    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "P" });
    const testLevel = (await rpc(tenant.cookie, "GET", "testCases.listLevels")).data[0];
    const testCase = await rpc(tenant.cookie, "POST", "testCases.create", {
      productId: product.data.id,
      levelId: testLevel.id,
      customFieldValues: [await testTypeCustomFieldValue(tenant.cookie, "Verification")],
      title: "TC",
      steps: [{ description: "<p>Step</p>", expectedResult: "<p>OK</p>" }],
    });

    const result = await rpc(tenant.cookie, "POST", "testCases.suggestSteps", {
      productId: product.data.id,
      originalSteps: testCase.data.steps.map((s: any) => ({
        key: s.id,
        description: s.description,
        expectedResult: s.expectedResult,
      })),
      history: [],
      instruction: "__mock_hallucinate_requirement__ please add a step",
    });
    expect(result.ok).toBe(true);
    expect(result.data.error).toBeUndefined();
    expect(result.data.upserts).toHaveLength(1);
    // The mock proposed a made-up requirementId that was never offered as context - the
    // server must strip it, not pass it through, or the client's next request (which
    // requires every requirementId to be a real uuid) would hard-fail.
    expect(result.data.upserts[0].requirementIds).toEqual([]);
  });

  test("a step's already-linked, genuinely real requirementId is never treated as hallucinated", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    await saveMockConnection(tenant);
    const req = await createRequirement(tenant);
    const testLevel = (await rpc(tenant.cookie, "GET", "testCases.listLevels")).data[0];
    await rpc(tenant.cookie, "POST", "testCases.create", {
      productId: req.productId,
      levelId: testLevel.id,
      customFieldValues: [await testTypeCustomFieldValue(tenant.cookie, "Verification")],
      title: "TC",
      steps: [{ description: "<p>Step</p>", expectedResult: "<p>OK</p>", requirementIds: [req.requirementId] }],
    });

    // __mock_modify_step__'s upsert doesn't itself carry a requirementId, so this is
    // really just confirming the request round-trips without error when a real,
    // already-linked id is present in `originalSteps` - the filter's job is to strip
    // ids that AREN'T real, not to be tripped up by ones that are.
    //
    // Honest gap: the filter treats "valid" as the union of the AI's (300-capped)
    // context list and whatever ids were already in `originalSteps` (see
    // testCases.suggestSteps's own comment) specifically so an already-linked
    // requirement beyond that cap survives an edit - that exact beyond-the-cap scenario
    // isn't exercised here, since creating 300+ requirements is too expensive for an
    // e2e test to set up. This test only confirms the ordinary, well-within-the-cap case
    // doesn't regress.
    const result = await rpc(tenant.cookie, "POST", "testCases.suggestSteps", {
      productId: req.productId,
      originalSteps: [{ key: "some-step-key", description: "<p>Step</p>", expectedResult: "<p>OK</p>", requirementIds: [req.requirementId] }],
      history: [],
      instruction: "__mock_modify_step__ please reword it",
    });
    expect(result.ok).toBe(true);
    expect(result.data.error).toBeUndefined();
  });

  test("RLS: one tenant's saved AI connection is invisible to another tenant", async () => {
    const tenantA = await registerTenant(`E2E Org A ${uniqueSuffix()}`);
    const tenantB = await registerTenant(`E2E Org B ${uniqueSuffix()}`);
    await saveMockConnection(tenantA);

    const asB = await rpc(tenantB.cookie, "GET", "llm.getConnection");
    expect(asB.data).toBeNull();
  });
});
