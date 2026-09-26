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
const MAILPIT_URL = process.env.E2E_MAILPIT_URL ?? "http://localhost:8025";

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Polls Mailpit (docker-compose.yml's local SMTP catcher) for the verification email sent
 * to `email`, since it's delivered asynchronously via the send-verification-email job -
 * see apps/worker/src/index.ts. Returns the verify-email link from the email body. */
async function getVerificationLink(email: string): Promise<string> {
  // pg-boss (packages/jobs) polls for new jobs every 2s by default, so give the
  // send-verification-email job + SMTP delivery to Mailpit a generous window.
  for (let attempt = 0; attempt < 60; attempt++) {
    const searchRes = await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`);
    if (searchRes.ok) {
      const search = (await searchRes.json()) as { messages: { ID: string }[] };
      const latest = search.messages[0];
      if (latest) {
        const msgRes = await fetch(`${MAILPIT_URL}/api/v1/message/${latest.ID}`);
        const msg = (await msgRes.json()) as { Text: string };
        const match = msg.Text.match(/https?:\/\/\S+verify-email\S+/);
        if (match) return match[0];
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`No verification email found for ${email} in Mailpit within timeout`);
}

/** Mirrors getVerificationLink - polls Mailpit for the invitation email sent to `email`
 * (apps/worker's send-invitation-email job), returning the accept-invite link. */
async function getInvitationLink(email: string): Promise<string> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const searchRes = await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`);
    if (searchRes.ok) {
      const search = (await searchRes.json()) as { messages: { ID: string }[] };
      const latest = search.messages[0];
      if (latest) {
        const msgRes = await fetch(`${MAILPIT_URL}/api/v1/message/${latest.ID}`);
        const msg = (await msgRes.json()) as { Text: string };
        const match = msg.Text.match(/https?:\/\/\S+accept-invite\S+/);
        if (match) return match[0];
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`No invitation email found for ${email} in Mailpit within timeout`);
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

/** Environment used to be its own dedicated table/FK; it's an ordinary "test run" custom
 * field now (seeded by default for every tenant, see custom-fields.ts's
 * seedDefaultCustomFields), required on every execution the same way the old column was.
 * Every test that used to fetch an environment id and pass `environmentId` now fetches
 * this field's id + its (also seeded) "Default" option id and passes it as
 * `customFieldValues` instead - same required-parameter shape, just generalized. */
async function defaultRunParam(cookie: string): Promise<{ fieldId: string; value: string }> {
  const fields = (await rpc(cookie, "GET", "settings.listCustomFields", { entityType: "test_run" })).data as Array<{
    id: string;
    name: string;
    options: Array<{ id: string; value: string }>;
  }>;
  const field = fields.find((f) => f.name === "Environment")!;
  return { fieldId: field.id, value: field.options[0]!.id };
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

  test("editing a draft updates that version in place; editing an approved requirement starts a new version", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const { requirementId } = await createRequirement(tenant);

    const firstEdit = await rpc(tenant.cookie, "POST", "requirements.editDraft", {
      requirementId,
      title: "Draft title",
      description: "Draft body",
    });
    expect(firstEdit.ok).toBe(true);
    const afterDraft = await rpc(tenant.cookie, "GET", "requirements.get", { id: requirementId });
    expect(afterDraft.data.versions).toHaveLength(1);
    expect(afterDraft.data.versions[0].versionNumber).toBe(1);
    expect(afterDraft.data.versions[0].title).toBe("Draft title");

    await moveToInReview(tenant, requirementId);
    const blockedWhileInReview = await rpc(tenant.cookie, "POST", "requirements.editDraft", {
      requirementId,
      title: "nope",
      description: "nope",
    });
    expect(blockedWhileInReview.ok).toBe(false);

    await rpc(tenant.cookie, "POST", "requirements.transition", { requirementId, toCategory: "approved" });
    const fromApproved = await rpc(tenant.cookie, "POST", "requirements.editDraft", {
      requirementId,
      title: "Next version",
      description: "Next body",
    });
    expect(fromApproved.ok).toBe(true);
    const afterApproved = await rpc(tenant.cookie, "GET", "requirements.get", { id: requirementId });
    expect(afterApproved.data.versions).toHaveLength(2);
    expect(afterApproved.data.versions[0].versionNumber).toBe(2);
    expect(afterApproved.data.versions[0].statusCategory).toBe("draft");
    expect(afterApproved.data.versions[0].title).toBe("Next version");
    expect(afterApproved.data.versions[1].versionNumber).toBe(1);
    expect(afterApproved.data.versions[1].statusCategory).toBe("approved");
    expect(afterApproved.data.versions[1].title).toBe("Draft title");
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
  test("registering seeds one default test level and one default (Environment) test run field", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const levels = await rpc(tenant.cookie, "GET", "testCases.listLevels");
    expect(levels.data.map((l: any) => l.name)).toEqual(["Default"]);
    const fields = await rpc(tenant.cookie, "GET", "settings.listCustomFields", { entityType: "test_run" });
    expect(fields.data.map((f: any) => f.name)).toEqual(["Environment"]);
    expect(fields.data[0].options.map((o: any) => o.value)).toEqual(["Default"]);
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
      customFieldValues: [await defaultRunParam(tenant.cookie)],
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
    const testCase = await rpc(tenantA.cookie, "POST", "testCases.create", {
      productId: product.data.id,
      levelId: testLevel.id,
      customFieldValues: [await testTypeCustomFieldValue(tenantA.cookie, "Verification")],
      title: "TC",
      steps: [{ description: "<p>S</p>", expectedResult: "<p>E</p>" }],
    });
    const execution = await rpc(tenantA.cookie, "POST", "testCases.startExecution", {
      testCaseId: testCase.data.testCase.id,
      customFieldValues: [await defaultRunParam(tenantA.cookie)],
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
    const testCase = await rpc(tenant.cookie, "POST", "testCases.create", {
      productId: product.data.id,
      levelId: testLevel.id,
      customFieldValues: [await testTypeCustomFieldValue(tenant.cookie, "Verification")],
      title: "TC",
      steps: [{ description: "<p>S</p>", expectedResult: "<p>E</p>" }],
    });
    await rpc(tenant.cookie, "POST", "testCases.startExecution", {
      testCaseId: testCase.data.testCase.id,
      customFieldValues: [await defaultRunParam(tenant.cookie)],
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

describe("e2e: settings - managing test levels", () => {
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

    // A draft Save writes tenant-defined fields in the same call as title/description,
    // not a second mutation - the values still aren't versioned, but the submit is one.
    const edited = await rpc(tenant.cookie, "POST", "requirements.editDraft", {
      requirementId,
      title: "T2",
      description: "D2",
      customFieldValues: [
        { fieldId: shortText.data.id, value: "Carol" },
        { fieldId: integer.data.id, value: 8 },
        { fieldId: boolean.data.id, value: true },
        { fieldId: date.data.id, value: "2026-02-01" },
      ],
    });
    expect(edited.ok).toBe(true);
    const afterEdit = await rpc(tenant.cookie, "GET", "requirements.get", { id: requirementId });
    expect(afterEdit.data.versions).toHaveLength(1);
    expect(afterEdit.data.versions[0].versionNumber).toBe(1);
    expect(afterEdit.data.versions[0].title).toBe("T2");
    expect(afterEdit.data.customFieldValues.find((v: any) => v.name === "Owner").value).toBe("Carol");
    expect(afterEdit.data.customFieldValues.find((v: any) => v.name === "Story Points").value).toBe("8");

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
    const environment = await defaultRunParam(tenant.cookie);
    const testCase = await rpc(tenant.cookie, "POST", "testCases.create", {
      productId: product.data.id,
      levelId: testLevel.id,
      customFieldValues: [await testTypeCustomFieldValue(tenant.cookie, "Verification")],
      title: "TC",
      steps: [{ description: "<p>S</p>", expectedResult: "<p>E</p>" }],
    });
    const execution = await rpc(tenant.cookie, "POST", "testCases.startExecution", {
      testCaseId: testCase.data.testCase.id,
      customFieldValues: [environment],
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
    const environment = await defaultRunParam(tenant.cookie);
    const testCase = await rpc(tenant.cookie, "POST", "testCases.create", {
      productId: product.data.id,
      levelId: testLevel.id,
      customFieldValues: [await testTypeCustomFieldValue(tenant.cookie, "Verification")],
      title: "TC",
      steps: [{ description: "<p>S</p>", expectedResult: "<p>E</p>" }],
    });
    const execution = await rpc(tenant.cookie, "POST", "testCases.startExecution", {
      testCaseId: testCase.data.testCase.id,
      customFieldValues: [environment],
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
    const environment = await defaultRunParam(tenant.cookie);
    const testCase = await rpc(tenant.cookie, "POST", "testCases.create", {
      productId: product.data.id,
      levelId: testLevel.id,
      customFieldValues: [await testTypeCustomFieldValue(tenant.cookie, "Verification")],
      title: "Example TC",
      steps: [{ description: "<p>S</p>", expectedResult: "<p>E</p>" }],
    });
    const execution = await rpc(tenant.cookie, "POST", "testCases.startExecution", {
      testCaseId: testCase.data.testCase.id,
      customFieldValues: [environment],
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
    const environment = await defaultRunParam(tenant.cookie);
    const testCase = await rpc(tenant.cookie, "POST", "testCases.create", {
      productId: product.data.id,
      levelId: testLevel.id,
      customFieldValues: [await testTypeCustomFieldValue(tenant.cookie, "Verification")],
      title: "TC",
      steps: [{ description: "<p>S</p>", expectedResult: "<p>E</p>" }],
    });
    const ex1 = await rpc(tenant.cookie, "POST", "testCases.startExecution", {
      testCaseId: testCase.data.testCase.id,
      customFieldValues: [environment],
    });
    const ex2 = await rpc(tenant.cookie, "POST", "testCases.startExecution", {
      testCaseId: testCase.data.testCase.id,
      customFieldValues: [environment],
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

describe("e2e: architecture", () => {
  async function setupProduct(tenant: TestTenant) {
    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "Architecture Product" });
    expect(product.ok).toBe(true);
    const levels = await rpc(tenant.cookie, "GET", "architecture.listLevels");
    expect(levels.ok).toBe(true);
    const sys = levels.data.find((l: any) => l.code === "SYSARCH");
    const sw = levels.data.find((l: any) => l.code === "SWARCH");
    expect(sys).toBeTruthy();
    expect(sw).toBeTruthy();
    return { productId: product.data.id as string, sys, sw };
  }

  async function createNode(
    tenant: TestTenant,
    input: {
      productId: string;
      levelId: string;
      kind: "software_item" | "software_unit" | "ots";
      parentId?: string;
      title: string;
    },
  ) {
    return rpc(tenant.cookie, "POST", "architecture.create", input);
  }

  test("registering seeds SYSARCH and SWARCH", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const levels = await rpc(tenant.cookie, "GET", "architecture.listLevels");
    expect(levels.ok).toBe(true);
    expect(levels.data.map((l: any) => l.code)).toEqual(["SYSARCH", "SWARCH"]);
    expect(levels.data.map((l: any) => l.name)).toEqual(["System Architecture", "Software Architecture"]);
  });

  test("trees are isolated per architecture level", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const { productId, sys, sw } = await setupProduct(tenant);

    const sysItem = await createNode(tenant, {
      productId,
      levelId: sys.id,
      kind: "software_item",
      title: "System item",
    });
    expect(sysItem.ok).toBe(true);

    const swItem = await createNode(tenant, {
      productId,
      levelId: sw.id,
      kind: "software_item",
      title: "Software item",
    });
    expect(swItem.ok).toBe(true);

    const crossed = await createNode(tenant, {
      productId,
      levelId: sw.id,
      kind: "software_item",
      parentId: sysItem.data.node.id,
      title: "Cross-level child",
    });
    expect(crossed.ok).toBe(false);
    expect(crossed.error?.message).toMatch(/same architecture level/);

    const sysTree = await rpc(tenant.cookie, "GET", "architecture.listByProduct", { productId, levelId: sys.id });
    const swTree = await rpc(tenant.cookie, "GET", "architecture.listByProduct", { productId, levelId: sw.id });
    expect(sysTree.data.nodes.map((n: any) => n.id)).toEqual([sysItem.data.node.id]);
    expect(swTree.data.nodes.map((n: any) => n.id)).toEqual([swItem.data.node.id]);
  });

  test("nested item, unit, and OTS under both an item and a unit", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const { productId, sw } = await setupProduct(tenant);

    const item = await createNode(tenant, { productId, levelId: sw.id, kind: "software_item", title: "Controller" });
    expect(item.ok).toBe(true);
    const nested = await createNode(tenant, {
      productId,
      levelId: sw.id,
      kind: "software_item",
      parentId: item.data.node.id,
      title: "Nested item",
    });
    expect(nested.ok).toBe(true);
    const unit = await createNode(tenant, {
      productId,
      levelId: sw.id,
      kind: "software_unit",
      parentId: nested.data.node.id,
      title: "Control loop",
    });
    expect(unit.ok).toBe(true);
    const otsUnderItem = await createNode(tenant, {
      productId,
      levelId: sw.id,
      kind: "ots",
      parentId: item.data.node.id,
      title: "Library under item",
    });
    expect(otsUnderItem.ok).toBe(true);
    const otsUnderUnit = await createNode(tenant, {
      productId,
      levelId: sw.id,
      kind: "ots",
      parentId: unit.data.node.id,
      title: "Library under unit",
    });
    expect(otsUnderUnit.ok).toBe(true);

    const tree = await rpc(tenant.cookie, "GET", "architecture.listByProduct", { productId, levelId: sw.id });
    expect(tree.data.tree).toHaveLength(1);
    expect(tree.data.tree[0].children.map((c: any) => c.title).sort()).toEqual(["Library under item", "Nested item"]);
    const nestedNode = tree.data.tree[0].children.find((c: any) => c.title === "Nested item");
    expect(nestedNode.children).toHaveLength(1);
    expect(nestedNode.children[0].title).toBe("Control loop");
    expect(nestedNode.children[0].children[0].title).toBe("Library under unit");
    expect(tree.data.mermaid).toMatch(/^flowchart TB\n  n1\[/);
    expect(tree.data.mermaid).not.toMatch(/^\s*[A-Z]+-\d+/m);
  });

  test("containment rules reject illegal parents and children", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const { productId, sw } = await setupProduct(tenant);

    const unitAtRoot = await createNode(tenant, { productId, levelId: sw.id, kind: "software_unit", title: "Orphan unit" });
    expect(unitAtRoot.ok).toBe(false);
    expect(unitAtRoot.error?.message).toMatch(/software item can sit at the root/);

    const otsAtRoot = await createNode(tenant, { productId, levelId: sw.id, kind: "ots", title: "Orphan OTS" });
    expect(otsAtRoot.ok).toBe(false);
    expect(otsAtRoot.error?.message).toMatch(/software item can sit at the root/);

    const item = await createNode(tenant, { productId, levelId: sw.id, kind: "software_item", title: "Item" });
    const unit = await createNode(tenant, {
      productId,
      levelId: sw.id,
      kind: "software_unit",
      parentId: item.data.node.id,
      title: "Unit",
    });
    expect(unit.ok).toBe(true);

    const itemUnderUnit = await createNode(tenant, {
      productId,
      levelId: sw.id,
      kind: "software_item",
      parentId: unit.data.node.id,
      title: "Item under unit",
    });
    expect(itemUnderUnit.ok).toBe(false);
    expect(itemUnderUnit.error?.message).toMatch(/software unit may only contain OTS/);

    const unitUnderUnit = await createNode(tenant, {
      productId,
      levelId: sw.id,
      kind: "software_unit",
      parentId: unit.data.node.id,
      title: "Unit under unit",
    });
    expect(unitUnderUnit.ok).toBe(false);
    expect(unitUnderUnit.error?.message).toMatch(/software unit may only contain OTS/);

    const ots = await createNode(tenant, {
      productId,
      levelId: sw.id,
      kind: "ots",
      parentId: item.data.node.id,
      title: "OTS leaf",
    });
    expect(ots.ok).toBe(true);
    const childOfOts = await createNode(tenant, {
      productId,
      levelId: sw.id,
      kind: "ots",
      parentId: ots.data.node.id,
      title: "OTS child",
    });
    expect(childOfOts.ok).toBe(false);
    expect(childOfOts.error?.message).toMatch(/OTS item cannot have children/);
  }, 30000);

  test("a software unit title can be renamed in place", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const { productId, sw } = await setupProduct(tenant);
    const item = await createNode(tenant, { productId, levelId: sw.id, kind: "software_item", title: "Item" });
    const unit = await createNode(tenant, {
      productId,
      levelId: sw.id,
      kind: "software_unit",
      parentId: item.data.node.id,
      title: "Unit",
    });
    expect(unit.ok).toBe(true);

    const renamed = await rpc(tenant.cookie, "POST", "architecture.update", {
      id: unit.data.node.id,
      title: "Control loop",
    });
    expect(renamed.ok).toBe(true);
    expect(renamed.data.node.title).toBe("Control loop");
    expect(renamed.data.node.parentId).toBe(item.data.node.id);
  });

  test("creating a product seeds SYSARCH and SWARCH when the tenant has none", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const pg = new SQL(PG_SUPERUSER_URL);
    try {
      await pg`delete from levels where tenant_id = ${tenant.tenantId}::uuid and kind = 'architecture'`;
    } finally {
      await pg.close();
    }

    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "After wipe" });
    expect(product.ok).toBe(true);

    const pgCheck = new SQL(PG_SUPERUSER_URL);
    try {
      const rows = await pgCheck`
        select code from levels
        where tenant_id = ${tenant.tenantId}::uuid and kind = 'architecture'
        order by sort_order
      `;
      expect(rows.map((r: { code: string }) => r.code)).toEqual(["SYSARCH", "SWARCH"]);
    } finally {
      await pgCheck.close();
    }
  });

  test("listLevels seeds SYSARCH and SWARCH when the tenant has none", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const pg = new SQL(PG_SUPERUSER_URL);
    try {
      await pg`delete from levels where tenant_id = ${tenant.tenantId}::uuid and kind = 'architecture'`;
    } finally {
      await pg.close();
    }

    const levels = await rpc(tenant.cookie, "GET", "architecture.listLevels");
    expect(levels.ok).toBe(true);
    expect(levels.data.map((l: any) => l.code)).toEqual(["SYSARCH", "SWARCH"]);
  });

  test("delete is blocked while children exist", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const { productId, sw } = await setupProduct(tenant);
    const item = await createNode(tenant, { productId, levelId: sw.id, kind: "software_item", title: "Item" });
    await createNode(tenant, {
      productId,
      levelId: sw.id,
      kind: "software_item",
      parentId: item.data.node.id,
      title: "Child",
    });

    const blocked = await rpc(tenant.cookie, "POST", "architecture.delete", { id: item.data.node.id });
    expect(blocked.ok).toBe(false);
    expect(blocked.error?.message).toMatch(/still has children/);

    const stillThere = await rpc(tenant.cookie, "GET", "architecture.get", { id: item.data.node.id });
    expect(stillThere.ok).toBe(true);
  });

  test("cannot delete an architecture level that still has nodes", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const { productId, sw } = await setupProduct(tenant);
    await createNode(tenant, { productId, levelId: sw.id, kind: "software_item", title: "Item" });

    const blocked = await rpc(tenant.cookie, "POST", "settings.deleteArchitectureLevel", { levelId: sw.id });
    expect(blocked.ok).toBe(false);
    expect(blocked.error?.message).toMatch(/architecture nodes using it/);

    const extra = await rpc(tenant.cookie, "POST", "settings.createArchitectureLevel", {
      name: "Pump Software",
      code: "PUMPSW",
    });
    expect(extra.ok).toBe(true);
    const deleted = await rpc(tenant.cookie, "POST", "settings.deleteArchitectureLevel", { levelId: extra.data.id });
    expect(deleted.ok).toBe(true);
  });

  test("nodes can link many requirements and test cases; lists and trace reflect them", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const { productId, sw } = await setupProduct(tenant);

    const unit = await createNode(tenant, {
      productId,
      levelId: sw.id,
      kind: "software_item",
      title: "Linked unit host",
    });
    expect(unit.ok).toBe(true);
    const unitId = unit.data.node.id as string;

    const otherUnit = await createNode(tenant, {
      productId,
      levelId: sw.id,
      kind: "software_item",
      title: "Second unit",
    });
    expect(otherUnit.ok).toBe(true);
    const otherUnitId = otherUnit.data.node.id as string;

    const reqLevel = (await rpc(tenant.cookie, "GET", "requirements.listLevels")).data[0];
    const reqA = await rpc(tenant.cookie, "POST", "requirements.create", {
      productId,
      levelId: reqLevel.id,
      title: "Req A",
      description: "A",
    });
    const reqB = await rpc(tenant.cookie, "POST", "requirements.create", {
      productId,
      levelId: reqLevel.id,
      title: "Req B",
      description: "B",
    });
    expect(reqA.ok).toBe(true);
    expect(reqB.ok).toBe(true);
    const reqAId = reqA.data.requirement.id as string;
    const reqBId = reqB.data.requirement.id as string;

    const testLevel = (await rpc(tenant.cookie, "GET", "testCases.listLevels")).data[0];
    const tc = await rpc(tenant.cookie, "POST", "testCases.create", {
      productId,
      levelId: testLevel.id,
      customFieldValues: [await testTypeCustomFieldValue(tenant.cookie, "Verification")],
      title: "TC linked",
      steps: [{ description: "do", expectedResult: "ok" }],
    });
    expect(tc.ok).toBe(true);
    const tcId = tc.data.testCase.id as string;

    const linked = await rpc(tenant.cookie, "POST", "architecture.update", {
      id: unitId,
      title: "Linked unit host",
      requirementIds: [reqAId, reqBId],
      testCaseIds: [tcId],
    });
    expect(linked.ok).toBe(true);

    // Many architecture nodes per requirement (inverse write).
    const fromReq = await rpc(tenant.cookie, "POST", "requirements.setArchitectureLinks", {
      requirementId: reqAId,
      architectureNodeIds: [unitId, otherUnitId],
    });
    expect(fromReq.ok).toBe(true);

    const fromTc = await rpc(tenant.cookie, "POST", "testCases.update", {
      testCaseId: tcId,
      title: "TC linked",
      architectureNodeIds: [unitId, otherUnitId],
      steps: [{ id: tc.data.steps[0].id, description: "do", expectedResult: "ok" }],
      customFieldValues: [await testTypeCustomFieldValue(tenant.cookie, "Verification")],
    });
    expect(fromTc.ok).toBe(true);

    const nodeDetail = await rpc(tenant.cookie, "GET", "architecture.get", { id: unitId });
    expect(nodeDetail.ok).toBe(true);
    expect(nodeDetail.data.requirementLinks.map((r: any) => r.id).sort()).toEqual([reqAId, reqBId].sort());
    expect(nodeDetail.data.testCaseLinks.map((t: any) => t.id)).toEqual([tcId]);

    const reqDetail = await rpc(tenant.cookie, "GET", "requirements.get", { id: reqAId });
    expect(reqDetail.data.architectureLinks.map((n: any) => n.id).sort()).toEqual([unitId, otherUnitId].sort());

    const tcDetail = await rpc(tenant.cookie, "GET", "testCases.get", { id: tcId });
    expect(tcDetail.data.architectureLinks.map((n: any) => n.id).sort()).toEqual([unitId, otherUnitId].sort());

    const reqList = await rpc(tenant.cookie, "GET", "requirements.listByProduct", {
      productId,
      levelId: reqLevel.id,
    });
    const listedReq = reqList.data.find((r: any) => r.id === reqAId);
    expect(listedReq.architectureLinks.length).toBe(2);

    const tcList = await rpc(tenant.cookie, "GET", "testCases.listByProduct", {
      productId,
      levelId: testLevel.id,
    });
    const listedTc = tcList.data.find((t: any) => t.id === tcId);
    expect(listedTc.architectureLinks.length).toBe(2);

    const trace = await rpc(tenant.cookie, "GET", "architecture.listTrace", {
      productId,
      levelId: sw.id,
    });
    expect(trace.ok).toBe(true);
    const traceRow = trace.data.rows.find((r: any) => r.id === unitId);
    expect(traceRow.requirementLinks.map((r: any) => r.id).sort()).toEqual([reqAId, reqBId].sort());
    expect(traceRow.testCaseLinks.map((t: any) => t.id)).toEqual([tcId]);

    // Cross-product links are rejected.
    const otherProduct = await rpc(tenant.cookie, "POST", "products.create", { name: "Other product" });
    const foreignReq = await rpc(tenant.cookie, "POST", "requirements.create", {
      productId: otherProduct.data.id,
      levelId: reqLevel.id,
      title: "Foreign",
      description: "no",
    });
    const rejected = await rpc(tenant.cookie, "POST", "architecture.update", {
      id: unitId,
      title: "Linked unit host",
      requirementIds: [foreignReq.data.requirement.id],
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.error?.message).toMatch(/same product/);
  });
});

describe("e2e: NVD vulnerability scanning for OTS architecture items", () => {
  // A real NVD API key can never legitimately equal this sentinel - it's the one and
  // only trigger for createNvdClient's test-only fake client (see
  // packages/integrations/nvd/src/client.ts), and only fires when
  // ALLOW_MOCK_NVD_PROVIDER=1 is also set in the running stack's environment (see .env -
  // dev/CI only). Lets this whole feature be exercised over real HTTP against the real
  // DB without ever calling the real, rate-limited NVD API.
  const MOCK_API_KEY = "mock-nvd-key";

  async function saveMockConnection(tenant: TestTenant) {
    const res = await rpc(tenant.cookie, "POST", "vulnerabilities.saveConnection", { apiKey: MOCK_API_KEY });
    expect(res.ok).toBe(true);
  }

  async function setupOtsNode(tenant: TestTenant) {
    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "OTS Product" });
    const levels = await rpc(tenant.cookie, "GET", "architecture.listLevels");
    const sw = levels.data.find((l: any) => l.code === "SWARCH");
    // An OTS item can never be a tree root (only a software_item can) - parent it under
    // one, same as a real product's OTS items always sit under some item/unit.
    const parent = await rpc(tenant.cookie, "POST", "architecture.create", {
      productId: product.data.id,
      levelId: sw.id,
      kind: "software_item",
      title: "Host item",
    });
    expect(parent.ok).toBe(true);
    const node = await rpc(tenant.cookie, "POST", "architecture.create", {
      productId: product.data.id,
      levelId: sw.id,
      kind: "ots",
      parentId: parent.data.node.id,
      title: "Log4j",
      supplier: "Apache",
      version: "2.14.1",
    });
    expect(node.ok).toBe(true);
    return { productId: product.data.id as string, levelId: sw.id as string, nodeId: node.data.node.id as string };
  }

  test("no connection saved yet: getConnection reports no key and the public throttle", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const got = await rpc(tenant.cookie, "GET", "vulnerabilities.getConnection");
    expect(got.data).toMatchObject({ hasApiKey: false });
  });

  test("saving a connection never echoes the key back, and it can be cleared explicitly", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    await saveMockConnection(tenant);

    const first = await rpc(tenant.cookie, "GET", "vulnerabilities.getConnection");
    expect(first.data.hasApiKey).toBe(true);
    expect(first.data.apiKey).toBeUndefined();

    const cleared = await rpc(tenant.cookie, "POST", "vulnerabilities.saveConnection", { apiKey: null });
    expect(cleared.ok).toBe(true);
    const second = await rpc(tenant.cookie, "GET", "vulnerabilities.getConnection");
    expect(second.data.hasApiKey).toBe(false);
  });

  test("RLS: one tenant's saved NVD connection is invisible to another tenant", async () => {
    const tenantA = await registerTenant(`E2E Org A ${uniqueSuffix()}`);
    const tenantB = await registerTenant(`E2E Org B ${uniqueSuffix()}`);
    await saveMockConnection(tenantA);

    const asB = await rpc(tenantB.cookie, "GET", "vulnerabilities.getConnection");
    expect(asB.data.hasApiKey).toBe(false);
  });

  test("testConnection succeeds against the mock provider", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    await saveMockConnection(tenant);
    const result = await rpc(tenant.cookie, "POST", "vulnerabilities.testConnection");
    expect(result.ok).toBe(true);
    expect(result.data.ok).toBe(true);
  });

  test("scanning a non-OTS node is rejected", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    await saveMockConnection(tenant);
    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "P" });
    const levels = await rpc(tenant.cookie, "GET", "architecture.listLevels");
    const sw = levels.data.find((l: any) => l.code === "SWARCH");
    const item = await rpc(tenant.cookie, "POST", "architecture.create", {
      productId: product.data.id,
      levelId: sw.id,
      kind: "software_item",
      title: "Not OTS",
    });
    const scan = await rpc(tenant.cookie, "POST", "vulnerabilities.scanNode", { nodeId: item.data.node.id });
    expect(scan.ok).toBe(false);
    expect(scan.error?.message).toMatch(/only OTS items/);
  });

  test("scan -> list -> annotate -> re-scan preserves the annotation and only new CVEs are untriaged", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    await saveMockConnection(tenant);
    const { nodeId } = await setupOtsNode(tenant);

    const scan = await rpc(tenant.cookie, "POST", "vulnerabilities.scanNode", { nodeId });
    expect(scan.ok).toBe(true);
    expect(scan.data.resultCount).toBeGreaterThan(0);
    expect(scan.data.newFindingCount).toBe(scan.data.resultCount);

    const list = await rpc(tenant.cookie, "GET", "vulnerabilities.listForNode", { nodeId });
    expect(list.ok).toBe(true);
    expect(list.data.latestScan.status).toBe("completed");
    expect(list.data.latestScan.matchType).toBe("keyword"); // no cpe set on this node yet
    expect(list.data.findings.length).toBeGreaterThan(0);
    const finding = list.data.findings[0];
    // An unannotated finding defaults to the conservative assumption: real and applicable.
    expect(finding.isNew).toBe(true);
    expect(finding.affectsProduct).toBe(true);
    expect(finding.falsePositive).toBe(false);

    // Confirming the default (affectsProduct=true, falsePositive=false) needs no rationale.
    const confirmed = await rpc(tenant.cookie, "POST", "vulnerabilities.annotate", {
      nodeId,
      cveId: finding.cveId,
      assessed: true,
      affectsProduct: true,
      falsePositive: false,
      rationale: "",
    });
    expect(confirmed.ok).toBe(true);
    const afterConfirm = await rpc(tenant.cookie, "GET", "vulnerabilities.listForNode", { nodeId });
    const confirmedFinding = afterConfirm.data.findings.find((f: any) => f.cveId === finding.cveId);
    expect(confirmedFinding.isNew).toBe(false);
    expect(confirmedFinding.assessed).toBe(true);
    expect(confirmedFinding.affectsProduct).toBe(true);

    // Marking as false positive without a rationale is rejected.
    const noRationale = await rpc(tenant.cookie, "POST", "vulnerabilities.annotate", {
      nodeId,
      cveId: finding.cveId,
      assessed: true,
      affectsProduct: true,
      falsePositive: true,
      rationale: "   ",
    });
    expect(noRationale.ok).toBe(false);

    const annotate = await rpc(tenant.cookie, "POST", "vulnerabilities.annotate", {
      nodeId,
      cveId: finding.cveId,
      assessed: true,
      affectsProduct: true,
      falsePositive: true,
      rationale: "Not reachable from any network-facing code path.",
      notes: "Ticket TRACK-123 has the full writeup.",
    });
    expect(annotate.ok).toBe(true);

    // Re-scan: the same CVE is reported again, but its annotation survives (no longer
    // "new"), which is the whole point - re-scanning only needs to triage new findings.
    const rescan = await rpc(tenant.cookie, "POST", "vulnerabilities.scanNode", { nodeId });
    expect(rescan.ok).toBe(true);
    expect(rescan.data.newFindingCount).toBe(0);

    const relisted = await rpc(tenant.cookie, "GET", "vulnerabilities.listForNode", { nodeId });
    const relistedFinding = relisted.data.findings.find((f: any) => f.cveId === finding.cveId);
    expect(relistedFinding.isNew).toBe(false);
    expect(relistedFinding.falsePositive).toBe(true);
    expect(relistedFinding.rationale).toBe("Not reachable from any network-facing code path.");
    expect(relistedFinding.notes).toBe("Ticket TRACK-123 has the full writeup.");

    // A real vulnerability that just doesn't apply here also requires a rationale, and is
    // independent of falsePositive - the whole reason these are two toggles, not one enum.
    const notApplicable = await rpc(tenant.cookie, "POST", "vulnerabilities.annotate", {
      nodeId,
      cveId: finding.cveId,
      assessed: true,
      affectsProduct: false,
      falsePositive: false,
      rationale: "This code path is never invoked by our usage of the library.",
    });
    expect(notApplicable.ok).toBe(true);
    const afterNotApplicable = await rpc(tenant.cookie, "GET", "vulnerabilities.listForNode", { nodeId });
    const notApplicableFinding = afterNotApplicable.data.findings.find((f: any) => f.cveId === finding.cveId);
    expect(notApplicableFinding.affectsProduct).toBe(false);
    expect(notApplicableFinding.falsePositive).toBe(false);
  });

  test("assessed and notes are independent of the affects/false-positive toggles and never require a rationale", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    await saveMockConnection(tenant);
    const { nodeId } = await setupOtsNode(tenant);
    await rpc(tenant.cookie, "POST", "vulnerabilities.scanNode", { nodeId });
    const list = await rpc(tenant.cookie, "GET", "vulnerabilities.listForNode", { nodeId });
    const cveId = list.data.findings[0].cveId;
    expect(list.data.findings[0].assessed).toBe(false);
    expect(list.data.findings[0].notes).toBeNull();

    // Ticking "assessed" with defaults otherwise unchanged and no rationale is a valid
    // save on its own - this is the one case a plain toggle can't express (nothing else
    // about the row changes), so there has to be a way to record "reviewed, no issue"
    // without touching affectsProduct/falsePositive at all.
    const assessedOnly = await rpc(tenant.cookie, "POST", "vulnerabilities.annotate", {
      nodeId,
      cveId,
      assessed: true,
      affectsProduct: true,
      falsePositive: false,
      rationale: "",
      notes: "Looked at this during the 2026-09 review; no action needed.",
    });
    expect(assessedOnly.ok).toBe(true);

    const relisted = await rpc(tenant.cookie, "GET", "vulnerabilities.listForNode", { nodeId });
    const relistedFinding = relisted.data.findings.find((f: any) => f.cveId === cveId);
    expect(relistedFinding.assessed).toBe(true);
    expect(relistedFinding.affectsProduct).toBe(true);
    expect(relistedFinding.falsePositive).toBe(false);
    expect(relistedFinding.notes).toBe("Looked at this during the 2026-09 review; no action needed.");

    // Notes can be cleared back to null independently of everything else.
    const clearedNotes = await rpc(tenant.cookie, "POST", "vulnerabilities.annotate", {
      nodeId,
      cveId,
      assessed: true,
      affectsProduct: true,
      falsePositive: false,
      rationale: "",
      notes: "",
    });
    expect(clearedNotes.ok).toBe(true);
    const afterClear = await rpc(tenant.cookie, "GET", "vulnerabilities.listForNode", { nodeId });
    expect(afterClear.data.findings.find((f: any) => f.cveId === cveId).notes).toBeNull();
  });

  test("an exact CPE takes precedence over the supplier/title/version keyword fallback", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    await saveMockConnection(tenant);
    const { nodeId } = await setupOtsNode(tenant);

    const recorded = await rpc(tenant.cookie, "POST", "vulnerabilities.recordVersion", {
      nodeId,
      version: "2.14.1",
      cpe: "cpe:2.3:a:apache:log4j:2.14.1:*:*:*:*:*:*:*",
    });
    expect(recorded.ok).toBe(true);

    const scan = await rpc(tenant.cookie, "POST", "vulnerabilities.scanNode", { nodeId });
    expect(scan.ok).toBe(true);
    expect(scan.data.matchType).toBe("cpe");
  });

  test("architecture.get exposes version history, newest first, with the current one distinct from past ones", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const { nodeId } = await setupOtsNode(tenant); // created with version 2.14.1

    const bumped = await rpc(tenant.cookie, "POST", "vulnerabilities.recordVersion", { nodeId, version: "2.15.1" });
    expect(bumped.ok).toBe(true);

    const detail = await rpc(tenant.cookie, "GET", "architecture.get", { id: nodeId });
    expect(detail.ok).toBe(true);
    expect(detail.data.node.currentVersion.version).toBe("2.15.1");
    expect(detail.data.versionHistory.map((v: any) => v.version)).toEqual(["2.15.1", "2.14.1"]);
    // The original version's CPE (never set) stays that way - recording a new version
    // never mutates an earlier one.
    expect(detail.data.versionHistory[1].cpe).toBeNull();
  });

  test("editing supplier alone leaves version history untouched", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const { nodeId } = await setupOtsNode(tenant);

    const updated = await rpc(tenant.cookie, "POST", "architecture.update", {
      id: nodeId,
      title: "Log4j",
      supplier: "Apache Software Foundation",
    });
    expect(updated.ok).toBe(true);

    const detail = await rpc(tenant.cookie, "GET", "architecture.get", { id: nodeId });
    expect(detail.data.node.supplier).toBe("Apache Software Foundation");
    expect(detail.data.node.currentVersion.version).toBe("2.14.1");
    expect(detail.data.versionHistory.length).toBe(1);
  });

  test("recording a version on a non-OTS node is rejected", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "P" });
    const levels = await rpc(tenant.cookie, "GET", "architecture.listLevels");
    const sw = levels.data.find((l: any) => l.code === "SWARCH");
    const item = await rpc(tenant.cookie, "POST", "architecture.create", {
      productId: product.data.id,
      levelId: sw.id,
      kind: "software_item",
      title: "Not OTS",
    });
    const record = await rpc(tenant.cookie, "POST", "vulnerabilities.recordVersion", {
      nodeId: item.data.node.id,
      version: "1.0",
    });
    expect(record.ok).toBe(false);
    expect(record.error?.message).toMatch(/only OTS items/);
  });

  test("bumping the version marks existing findings as not confirmed until re-scanned, but keeps their annotation", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    await saveMockConnection(tenant);
    const { nodeId } = await setupOtsNode(tenant);

    const scan1 = await rpc(tenant.cookie, "POST", "vulnerabilities.scanNode", { nodeId });
    expect(scan1.ok).toBe(true);
    const beforeBump = await rpc(tenant.cookie, "GET", "vulnerabilities.listForNode", { nodeId });
    const cveId = beforeBump.data.findings[0].cveId;
    expect(beforeBump.data.findings[0].confirmedUnderCurrentVersion).toBe(true);

    await rpc(tenant.cookie, "POST", "vulnerabilities.annotate", {
      nodeId,
      cveId,
      assessed: true,
      affectsProduct: true,
      falsePositive: true,
      rationale: "Known false positive for this component.",
    });

    const bump = await rpc(tenant.cookie, "POST", "vulnerabilities.recordVersion", { nodeId, version: "2.15.1" });
    expect(bump.ok).toBe(true);

    // Not re-scanned yet under 2.15.1 - the finding confirmed under 2.14.1 is now stale,
    // but its annotation (set before the bump) is untouched.
    const afterBump = await rpc(tenant.cookie, "GET", "vulnerabilities.listForNode", { nodeId });
    const findingAfterBump = afterBump.data.findings.find((f: any) => f.cveId === cveId);
    expect(findingAfterBump.confirmedUnderCurrentVersion).toBe(false);
    expect(findingAfterBump.falsePositive).toBe(true);
    expect(findingAfterBump.rationale).toBe("Known false positive for this component.");

    // Re-scanning under the new version re-confirms it.
    const scan2 = await rpc(tenant.cookie, "POST", "vulnerabilities.scanNode", { nodeId });
    expect(scan2.ok).toBe(true);
    const afterRescan = await rpc(tenant.cookie, "GET", "vulnerabilities.listForNode", { nodeId });
    const findingAfterRescan = afterRescan.data.findings.find((f: any) => f.cveId === cveId);
    expect(findingAfterRescan.confirmedUnderCurrentVersion).toBe(true);
  });

  test("RLS: findings and annotations from one tenant are invisible to another", async () => {
    const tenantA = await registerTenant(`E2E Org A ${uniqueSuffix()}`);
    const tenantB = await registerTenant(`E2E Org B ${uniqueSuffix()}`);
    await saveMockConnection(tenantA);
    const { nodeId } = await setupOtsNode(tenantA);
    await rpc(tenantA.cookie, "POST", "vulnerabilities.scanNode", { nodeId });

    const asB = await rpc(tenantB.cookie, "GET", "vulnerabilities.listForNode", { nodeId });
    // Cross-tenant node id doesn't resolve for tenant B (RLS-scoped node lookup fails).
    expect(asB.ok).toBe(false);
  });

  test("the CPE search helper returns candidates through the mock provider", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    await saveMockConnection(tenant);
    const result = await rpc(tenant.cookie, "POST", "vulnerabilities.searchCpe", { keyword: "Apache Log4j" });
    expect(result.ok).toBe(true);
    expect(result.data.length).toBeGreaterThan(0);
    expect(result.data[0].cpeName).toContain("cpe:2.3:");
  });

  test("otsSummary reports per-version finding counts by triage status", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    await saveMockConnection(tenant);
    const { productId, levelId, nodeId } = await setupOtsNode(tenant);

    const beforeScan = await rpc(tenant.cookie, "GET", "vulnerabilities.otsSummary", { productId, levelId });
    expect(beforeScan.ok).toBe(true);
    const rowBefore = beforeScan.data.find((r: any) => r.node.id === nodeId);
    // setupOtsNode already records an initial version (2.14.1) - exactly one version on
    // record, current, with nothing scanned under it yet.
    expect(rowBefore.versions).toHaveLength(1);
    expect(rowBefore.versions[0].isCurrent).toBe(true);
    expect(rowBefore.versions[0].counts).toEqual({ total: 0, new: 0, confirmed: 0, notApplicable: 0, falsePositive: 0 });
    expect(rowBefore.versions[0].latestScan).toBeNull();

    await rpc(tenant.cookie, "POST", "vulnerabilities.scanNode", { nodeId });
    const afterScan = await rpc(tenant.cookie, "GET", "vulnerabilities.otsSummary", { productId, levelId });
    const versionAfterScan = afterScan.data.find((r: any) => r.node.id === nodeId).versions[0];
    expect(versionAfterScan.counts.total).toBeGreaterThan(0);
    expect(versionAfterScan.counts.new).toBe(versionAfterScan.counts.total);
    expect(versionAfterScan.latestScan.status).toBe("completed");

    const firstCveId = (await rpc(tenant.cookie, "GET", "vulnerabilities.listForNode", { nodeId })).data.findings[0]
      .cveId;
    await rpc(tenant.cookie, "POST", "vulnerabilities.annotate", {
      nodeId,
      cveId: firstCveId,
      assessed: true,
      affectsProduct: false,
      falsePositive: false,
      rationale: "Never invoked by this product.",
    });
    const afterAnnotate = await rpc(tenant.cookie, "GET", "vulnerabilities.otsSummary", { productId, levelId });
    const versionAfterAnnotate = afterAnnotate.data.find((r: any) => r.node.id === nodeId).versions[0];
    expect(versionAfterAnnotate.counts.notApplicable).toBe(1);
    expect(versionAfterAnnotate.counts.new).toBe(versionAfterScan.counts.total - 1);
  });

  test("otsSummary carries full version history, attributing counts to whichever version last confirmed each finding", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    await saveMockConnection(tenant);
    const { productId, levelId, nodeId } = await setupOtsNode(tenant); // version 2.14.1

    await rpc(tenant.cookie, "POST", "vulnerabilities.scanNode", { nodeId });
    await rpc(tenant.cookie, "POST", "vulnerabilities.recordVersion", { nodeId, version: "2.15.1" });
    // Deliberately not re-scanned under 2.15.1 yet.

    const summary = await rpc(tenant.cookie, "GET", "vulnerabilities.otsSummary", { productId, levelId });
    expect(summary.ok).toBe(true);
    const row = summary.data.find((r: any) => r.node.id === nodeId);
    expect(row.versions).toHaveLength(2);
    expect(row.versions.map((v: any) => v.version)).toEqual(["2.15.1", "2.14.1"]); // newest first

    const current = row.versions.find((v: any) => v.version === "2.15.1");
    const previous = row.versions.find((v: any) => v.version === "2.14.1");
    expect(current.isCurrent).toBe(true);
    expect(current.counts.total).toBe(0); // never scanned under 2.15.1
    expect(current.latestScan).toBeNull();
    expect(previous.isCurrent).toBe(false);
    expect(previous.counts.total).toBeGreaterThan(0); // the scan that ran under 2.14.1
    expect(previous.latestScan.status).toBe("completed");

    // Re-scanning under 2.15.1 moves the finding's count over to the new version and
    // leaves the old version showing nothing outstanding.
    await rpc(tenant.cookie, "POST", "vulnerabilities.scanNode", { nodeId });
    const afterRescan = await rpc(tenant.cookie, "GET", "vulnerabilities.otsSummary", { productId, levelId });
    const rowAfter = afterRescan.data.find((r: any) => r.node.id === nodeId);
    const currentAfter = rowAfter.versions.find((v: any) => v.version === "2.15.1");
    const previousAfter = rowAfter.versions.find((v: any) => v.version === "2.14.1");
    expect(currentAfter.counts.total).toBeGreaterThan(0);
    expect(previousAfter.counts.total).toBe(0);
  });
});

describe("e2e: software versions module", () => {
  test("create, list, update, and delete a software version", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "P" });
    const productId = product.data.id;

    const created = await rpc(tenant.cookie, "POST", "softwareVersions.create", {
      productId,
      versionNumber: "1.0.0",
      description: "First release",
      releaseDate: "2026-01-15",
    });
    expect(created.ok).toBe(true);
    expect(created.data).toMatchObject({ versionNumber: "1.0.0", description: "First release" });

    const listed = await rpc(tenant.cookie, "GET", "softwareVersions.listByProduct", { productId });
    expect(listed.data.map((v: any) => v.versionNumber)).toEqual(["1.0.0"]);

    const updated = await rpc(tenant.cookie, "POST", "softwareVersions.update", {
      id: created.data.id,
      versionNumber: "1.0.1",
      description: "Patched",
    });
    expect(updated.ok).toBe(true);
    expect(updated.data.versionNumber).toBe("1.0.1");

    const deleted = await rpc(tenant.cookie, "POST", "softwareVersions.delete", { id: created.data.id });
    expect(deleted.ok).toBe(true);
    const afterDelete = await rpc(tenant.cookie, "GET", "softwareVersions.listByProduct", { productId });
    expect(afterDelete.data).toHaveLength(0);
  });

  test("version numbers must be unique per product, but not across products", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const productA = await rpc(tenant.cookie, "POST", "products.create", { name: "A" });
    const productB = await rpc(tenant.cookie, "POST", "products.create", { name: "B" });

    const first = await rpc(tenant.cookie, "POST", "softwareVersions.create", {
      productId: productA.data.id,
      versionNumber: "1.0.0",
    });
    expect(first.ok).toBe(true);

    const duplicate = await rpc(tenant.cookie, "POST", "softwareVersions.create", {
      productId: productA.data.id,
      versionNumber: "1.0.0",
    });
    expect(duplicate.ok).toBe(false);
    expect(duplicate.error?.message).toMatch(/already exists/);

    // Same version number, different product - allowed.
    const sameNumberOtherProduct = await rpc(tenant.cookie, "POST", "softwareVersions.create", {
      productId: productB.data.id,
      versionNumber: "1.0.0",
    });
    expect(sameNumberOtherProduct.ok).toBe(true);
  });

  test("a requirement can be tagged with software versions, but not with another product's", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const { productId, requirementId } = await createRequirement(tenant);
    const v1 = await rpc(tenant.cookie, "POST", "softwareVersions.create", { productId, versionNumber: "1.0" });
    const v2 = await rpc(tenant.cookie, "POST", "softwareVersions.create", { productId, versionNumber: "1.1" });

    const setLinks = await rpc(tenant.cookie, "POST", "requirements.setSoftwareVersions", {
      requirementId,
      softwareVersionIds: [v1.data.id, v2.data.id],
    });
    expect(setLinks.ok).toBe(true);

    const detail = await rpc(tenant.cookie, "GET", "requirements.get", { id: requirementId });
    expect(detail.data.softwareVersions.map((v: any) => v.versionNumber).sort()).toEqual(["1.0", "1.1"]);

    // A version from an unrelated product is rejected, not silently linked.
    const otherProduct = await rpc(tenant.cookie, "POST", "products.create", { name: "Other" });
    const otherVersion = await rpc(tenant.cookie, "POST", "softwareVersions.create", {
      productId: otherProduct.data.id,
      versionNumber: "9.9",
    });
    const crossProduct = await rpc(tenant.cookie, "POST", "requirements.setSoftwareVersions", {
      requirementId,
      softwareVersionIds: [otherVersion.data.id],
    });
    expect(crossProduct.ok).toBe(false);
    expect(crossProduct.error?.message).toMatch(/same product/);
  });

  test("a test case can be tagged with software versions", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "P" });
    const productId = product.data.id;
    const testLevel = (await rpc(tenant.cookie, "GET", "testCases.listLevels")).data[0];
    const testCase = await rpc(tenant.cookie, "POST", "testCases.create", {
      productId,
      levelId: testLevel.id,
      customFieldValues: [await testTypeCustomFieldValue(tenant.cookie, "Verification")],
      title: "TC",
      steps: [{ description: "Step", expectedResult: "Result" }],
    });
    expect(testCase.ok).toBe(true);
    const version = await rpc(tenant.cookie, "POST", "softwareVersions.create", { productId, versionNumber: "2.0" });

    const setLinks = await rpc(tenant.cookie, "POST", "testCases.setSoftwareVersions", {
      testCaseId: testCase.data.testCase.id,
      softwareVersionIds: [version.data.id],
    });
    expect(setLinks.ok).toBe(true);

    const detail = await rpc(tenant.cookie, "GET", "testCases.get", { id: testCase.data.testCase.id });
    expect(detail.data.softwareVersions.map((v: any) => v.versionNumber)).toEqual(["2.0"]);
  });

  test("an OTS component version can be tagged with which release it shipped in", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "P" });
    const productId = product.data.id;
    const levels = await rpc(tenant.cookie, "GET", "architecture.listLevels");
    const sw = levels.data.find((l: any) => l.code === "SWARCH");
    const parent = await rpc(tenant.cookie, "POST", "architecture.create", {
      productId,
      levelId: sw.id,
      kind: "software_item",
      title: "Host item",
    });
    const node = await rpc(tenant.cookie, "POST", "architecture.create", {
      productId,
      levelId: sw.id,
      kind: "ots",
      parentId: parent.data.node.id,
      title: "Log4j",
      supplier: "Apache",
      version: "2.14.1",
    });
    expect(node.ok).toBe(true);
    const nodeId = node.data.node.id;
    const currentVersionId = node.data.node.currentVersion.id;
    const version = await rpc(tenant.cookie, "POST", "softwareVersions.create", { productId, versionNumber: "1.0" });

    const setLinks = await rpc(tenant.cookie, "POST", "architecture.setVersionSoftwareVersions", {
      nodeId,
      architectureNodeVersionId: currentVersionId,
      softwareVersionIds: [version.data.id],
    });
    expect(setLinks.ok).toBe(true);

    const detail = await rpc(tenant.cookie, "GET", "architecture.get", { id: nodeId });
    const currentVersionRow = detail.data.versionHistory.find((v: any) => v.id === currentVersionId);
    expect(currentVersionRow.softwareVersions.map((v: any) => v.versionNumber)).toEqual(["1.0"]);

    // A version id belonging to a different product is rejected.
    const otherProduct = await rpc(tenant.cookie, "POST", "products.create", { name: "Other" });
    const otherVersion = await rpc(tenant.cookie, "POST", "softwareVersions.create", {
      productId: otherProduct.data.id,
      versionNumber: "9.9",
    });
    const crossProduct = await rpc(tenant.cookie, "POST", "architecture.setVersionSoftwareVersions", {
      nodeId,
      architectureNodeVersionId: currentVersionId,
      softwareVersionIds: [otherVersion.data.id],
    });
    expect(crossProduct.ok).toBe(false);
    expect(crossProduct.error?.message).toMatch(/same product/);
  });

  test('recording a new OTS component version can copy "applies to versions" links from the previous one', async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "P" });
    const productId = product.data.id;
    const levels = await rpc(tenant.cookie, "GET", "architecture.listLevels");
    const sw = levels.data.find((l: any) => l.code === "SWARCH");
    const parent = await rpc(tenant.cookie, "POST", "architecture.create", {
      productId,
      levelId: sw.id,
      kind: "software_item",
      title: "Host item",
    });
    const node = await rpc(tenant.cookie, "POST", "architecture.create", {
      productId,
      levelId: sw.id,
      kind: "ots",
      parentId: parent.data.node.id,
      title: "Log4j",
      supplier: "Apache",
      version: "2.14.1",
    });
    const nodeId = node.data.node.id;
    const oldVersionId = node.data.node.currentVersion.id;
    const v1 = await rpc(tenant.cookie, "POST", "softwareVersions.create", { productId, versionNumber: "1.0" });
    const v2 = await rpc(tenant.cookie, "POST", "softwareVersions.create", { productId, versionNumber: "1.1" });
    await rpc(tenant.cookie, "POST", "architecture.setVersionSoftwareVersions", {
      nodeId,
      architectureNodeVersionId: oldVersionId,
      softwareVersionIds: [v1.data.id, v2.data.id],
    });

    const bumped = await rpc(tenant.cookie, "POST", "vulnerabilities.recordVersion", {
      nodeId,
      version: "2.15.1",
      copyLinksFromVersionId: oldVersionId,
    });
    expect(bumped.ok).toBe(true);
    const newVersionId = bumped.data.version.id;

    const detail = await rpc(tenant.cookie, "GET", "architecture.get", { id: nodeId });
    const newVersionRow = detail.data.versionHistory.find((v: any) => v.id === newVersionId);
    expect(newVersionRow.softwareVersions.map((v: any) => v.versionNumber).sort()).toEqual(["1.0", "1.1"]);

    // A snapshot, not a live link - editing the new version's tags afterward doesn't
    // reach back and affect the old version's.
    await rpc(tenant.cookie, "POST", "architecture.setVersionSoftwareVersions", {
      nodeId,
      architectureNodeVersionId: newVersionId,
      softwareVersionIds: [v1.data.id],
    });
    const afterEdit = await rpc(tenant.cookie, "GET", "architecture.get", { id: nodeId });
    const oldVersionRow = afterEdit.data.versionHistory.find((v: any) => v.id === oldVersionId);
    expect(oldVersionRow.softwareVersions.map((v: any) => v.versionNumber).sort()).toEqual(["1.0", "1.1"]);

    // Recording without copyLinksFromVersionId starts untagged, same as before this option existed.
    const bumpedAgain = await rpc(tenant.cookie, "POST", "vulnerabilities.recordVersion", { nodeId, version: "2.16.0" });
    const detailAgain = await rpc(tenant.cookie, "GET", "architecture.get", { id: nodeId });
    const untaggedRow = detailAgain.data.versionHistory.find((v: any) => v.id === bumpedAgain.data.version.id);
    expect(untaggedRow.softwareVersions).toEqual([]);
  });

  test("requirements.listByProduct includes each row's tagged software versions", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const { productId, requirementId, levelId } = await createRequirement(tenant);
    const untagged = await createRequirement(tenant, { productId });
    const version = await rpc(tenant.cookie, "POST", "softwareVersions.create", { productId, versionNumber: "1.0" });
    await rpc(tenant.cookie, "POST", "requirements.setSoftwareVersions", {
      requirementId,
      softwareVersionIds: [version.data.id],
    });

    const list = await rpc(tenant.cookie, "GET", "requirements.listByProduct", { productId, levelId });
    const taggedRow = list.data.find((r: any) => r.id === requirementId);
    const untaggedRow = list.data.find((r: any) => r.id === untagged.requirementId);
    expect(taggedRow.softwareVersions.map((v: any) => v.versionNumber)).toEqual(["1.0"]);
    expect(untaggedRow.softwareVersions).toEqual([]);
  });

  test("testCases.listByProduct includes each row's tagged software versions", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "P" });
    const productId = product.data.id;
    const testLevel = (await rpc(tenant.cookie, "GET", "testCases.listLevels")).data[0];
    const testCase = await rpc(tenant.cookie, "POST", "testCases.create", {
      productId,
      levelId: testLevel.id,
      customFieldValues: [await testTypeCustomFieldValue(tenant.cookie, "Verification")],
      title: "Tagged",
      steps: [{ description: "Step", expectedResult: "Result" }],
    });
    const untagged = await rpc(tenant.cookie, "POST", "testCases.create", {
      productId,
      levelId: testLevel.id,
      customFieldValues: [await testTypeCustomFieldValue(tenant.cookie, "Verification")],
      title: "Untagged",
      steps: [{ description: "Step", expectedResult: "Result" }],
    });
    const version = await rpc(tenant.cookie, "POST", "softwareVersions.create", { productId, versionNumber: "1.0" });
    await rpc(tenant.cookie, "POST", "testCases.setSoftwareVersions", {
      testCaseId: testCase.data.testCase.id,
      softwareVersionIds: [version.data.id],
    });

    const list = await rpc(tenant.cookie, "GET", "testCases.listByProduct", { productId, levelId: testLevel.id });
    const taggedRow = list.data.find((tc: any) => tc.id === testCase.data.testCase.id);
    const untaggedRow = list.data.find((tc: any) => tc.id === untagged.data.testCase.id);
    expect(taggedRow.softwareVersions.map((v: any) => v.versionNumber)).toEqual(["1.0"]);
    expect(untaggedRow.softwareVersions).toEqual([]);
  });

  test("vulnerabilities.otsSummary includes each version row's tagged software versions", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "P" });
    const productId = product.data.id;
    const levels = await rpc(tenant.cookie, "GET", "architecture.listLevels");
    const sw = levels.data.find((l: any) => l.code === "SWARCH");
    const parent = await rpc(tenant.cookie, "POST", "architecture.create", {
      productId,
      levelId: sw.id,
      kind: "software_item",
      title: "Host item",
    });
    const node = await rpc(tenant.cookie, "POST", "architecture.create", {
      productId,
      levelId: sw.id,
      kind: "ots",
      parentId: parent.data.node.id,
      title: "Log4j",
      supplier: "Apache",
      version: "2.14.1",
    });
    const nodeId = node.data.node.id;
    const currentVersionId = node.data.node.currentVersion.id;
    const version = await rpc(tenant.cookie, "POST", "softwareVersions.create", { productId, versionNumber: "1.0" });
    await rpc(tenant.cookie, "POST", "architecture.setVersionSoftwareVersions", {
      nodeId,
      architectureNodeVersionId: currentVersionId,
      softwareVersionIds: [version.data.id],
    });

    const summary = await rpc(tenant.cookie, "GET", "vulnerabilities.otsSummary", { productId, levelId: sw.id });
    const row = summary.data.find((r: any) => r.node.id === nodeId);
    const versionRow = row.versions.find((v: any) => v.id === currentVersionId);
    expect(versionRow.softwareVersions.map((v: any) => v.versionNumber)).toEqual(["1.0"]);
  });

  test("traceability.getMatrix includes each row's requirement-side and test-case-side tagged software versions", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const { productId, requirementId } = await createRequirement(tenant);
    const testLevel = (await rpc(tenant.cookie, "GET", "testCases.listLevels")).data[0];
    const testCase = await rpc(tenant.cookie, "POST", "testCases.create", {
      productId,
      levelId: testLevel.id,
      customFieldValues: [await testTypeCustomFieldValue(tenant.cookie, "Verification")],
      title: "TC",
      steps: [{ description: "Step", expectedResult: "Result", requirementIds: [requirementId] }],
    });
    const reqVersion = await rpc(tenant.cookie, "POST", "softwareVersions.create", { productId, versionNumber: "1.0" });
    const tcVersion = await rpc(tenant.cookie, "POST", "softwareVersions.create", { productId, versionNumber: "1.1" });
    await rpc(tenant.cookie, "POST", "requirements.setSoftwareVersions", {
      requirementId,
      softwareVersionIds: [reqVersion.data.id],
    });
    await rpc(tenant.cookie, "POST", "testCases.setSoftwareVersions", {
      testCaseId: testCase.data.testCase.id,
      softwareVersionIds: [tcVersion.data.id],
    });

    const matrix = await rpc(tenant.cookie, "GET", "traceability.getMatrix", { productId });
    const row = matrix.data.find((r: any) => r.requirementId === requirementId && r.testCaseId === testCase.data.testCase.id);
    expect(row.requirementSoftwareVersions.map((v: any) => v.versionNumber)).toEqual(["1.0"]);
    expect(row.testCaseSoftwareVersions.map((v: any) => v.versionNumber)).toEqual(["1.1"]);

    // A requirement with no covering test case still gets a row (a coverage gap), with
    // empty software versions on the test-case side, not a crash - reuse the level from
    // the same product for a second, uncovered requirement.
    const uncovered = await createRequirement(tenant, { productId, levelIndex: 0 });
    const matrixAfter = await rpc(tenant.cookie, "GET", "traceability.getMatrix", { productId });
    const gapRow = matrixAfter.data.find((r: any) => r.requirementId === uncovered.requirementId);
    expect(gapRow.testCaseSoftwareVersions).toEqual([]);
  });
});

describe("e2e: test sets", () => {
  async function createTestCase(tenant: TestTenant, productId: string, title: string) {
    const testLevel = (await rpc(tenant.cookie, "GET", "testCases.listLevels")).data[0];
    const testCase = await rpc(tenant.cookie, "POST", "testCases.create", {
      productId,
      levelId: testLevel.id,
      customFieldValues: [await testTypeCustomFieldValue(tenant.cookie, "Verification")],
      title,
      steps: [{ description: "<p>Do it</p>", expectedResult: "<p>Works</p>" }],
    });
    expect(testCase.ok).toBe(true);
    return testCase.data.testCase.id as string;
  }

  test("create, list, update, and delete a test set", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "P" });
    const productId = product.data.id;

    const created = await rpc(tenant.cookie, "POST", "testSets.create", {
      productId,
      name: "Smoke test",
      description: "Runs before every release",
    });
    expect(created.ok).toBe(true);
    expect(created.data).toMatchObject({ name: "Smoke test", description: "Runs before every release" });

    const listed = await rpc(tenant.cookie, "GET", "testSets.listByProduct", { productId });
    expect(listed.data).toMatchObject([{ id: created.data.id, name: "Smoke test", itemCount: 0 }]);

    const updated = await rpc(tenant.cookie, "POST", "testSets.update", {
      id: created.data.id,
      name: "Release smoke test",
      description: "Updated",
    });
    expect(updated.ok).toBe(true);
    expect(updated.data.name).toBe("Release smoke test");

    const deleted = await rpc(tenant.cookie, "POST", "testSets.delete", { id: created.data.id });
    expect(deleted.ok).toBe(true);
    const afterDelete = await rpc(tenant.cookie, "GET", "testSets.listByProduct", { productId });
    expect(afterDelete.data).toHaveLength(0);
  });

  test("the same test case can be added more than once, each under a different environment", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "P" });
    const productId = product.data.id;
    const testCaseId = await createTestCase(tenant, productId, "Login works");
    const defaultParam = await defaultRunParam(tenant.cookie);
    const vmOption = await rpc(tenant.cookie, "POST", "settings.createCustomFieldOption", {
      fieldId: defaultParam.fieldId,
      value: "VM",
    });

    const set = await rpc(tenant.cookie, "POST", "testSets.create", { productId, name: "Cross-env" });
    const testSetId = set.data.id;

    const onDefault = await rpc(tenant.cookie, "POST", "testSets.addItem", {
      testSetId,
      testCaseId,
      customFieldValues: [defaultParam],
    });
    expect(onDefault.ok).toBe(true);
    const onVm = await rpc(tenant.cookie, "POST", "testSets.addItem", {
      testSetId,
      testCaseId,
      customFieldValues: [{ fieldId: defaultParam.fieldId, value: vmOption.data.id }],
    });
    expect(onVm.ok).toBe(true);
    expect(onVm.data.id).not.toBe(onDefault.data.id);

    const detail = await rpc(tenant.cookie, "GET", "testSets.get", { id: testSetId });
    expect(detail.data.items).toHaveLength(2);
    expect(detail.data.items.every((i: any) => i.testCaseId === testCaseId)).toBe(true);
    expect(detail.data.items.map((i: any) => i.customFieldValues[0].optionLabel)).toEqual(["Default", "VM"]);

    const listed = await rpc(tenant.cookie, "GET", "testSets.listByProduct", { productId });
    expect(listed.data[0].itemCount).toBe(2);
  });

  test("test_run custom parameters can be set and read on an entry", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "P" });
    const productId = product.data.id;
    const testCaseId = await createTestCase(tenant, productId, "Checkout works");
    const envParam = await defaultRunParam(tenant.cookie);
    const browserField = await rpc(tenant.cookie, "POST", "settings.createCustomField", {
      entityType: "test_run",
      name: "Browser",
      fieldType: "short_text",
    });
    expect(browserField.ok).toBe(true);

    const set = await rpc(tenant.cookie, "POST", "testSets.create", { productId, name: "Browsers" });
    // Environment is required too - every save resends the full set of parameter values,
    // same "no partial patch" convention the requirement/test-case custom field forms use.
    const added = await rpc(tenant.cookie, "POST", "testSets.addItem", {
      testSetId: set.data.id,
      testCaseId,
      customFieldValues: [envParam, { fieldId: browserField.data.id, value: "Firefox" }],
    });
    expect(added.ok).toBe(true);

    let detail = await rpc(tenant.cookie, "GET", "testSets.get", { id: set.data.id });
    expect(detail.data.items[0].customFieldValues).toContainEqual(
      expect.objectContaining({ fieldId: browserField.data.id, value: "Firefox" }),
    );

    const updated = await rpc(tenant.cookie, "POST", "testSets.updateItem", {
      itemId: added.data.id,
      customFieldValues: [envParam, { fieldId: browserField.data.id, value: "Chrome" }],
    });
    expect(updated.ok).toBe(true);

    detail = await rpc(tenant.cookie, "GET", "testSets.get", { id: set.data.id });
    expect(detail.data.items[0].customFieldValues).toContainEqual(
      expect.objectContaining({ fieldId: browserField.data.id, value: "Chrome" }),
    );
  });

  test("entries can be reordered and removed", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "P" });
    const productId = product.data.id;
    const tc1 = await createTestCase(tenant, productId, "First");
    const tc2 = await createTestCase(tenant, productId, "Second");
    const tc3 = await createTestCase(tenant, productId, "Third");

    const envParam = await defaultRunParam(tenant.cookie);
    const set = await rpc(tenant.cookie, "POST", "testSets.create", { productId, name: "Ordered" });
    const testSetId = set.data.id;
    const item1 = await rpc(tenant.cookie, "POST", "testSets.addItem", { testSetId, testCaseId: tc1, customFieldValues: [envParam] });
    const item2 = await rpc(tenant.cookie, "POST", "testSets.addItem", { testSetId, testCaseId: tc2, customFieldValues: [envParam] });
    const item3 = await rpc(tenant.cookie, "POST", "testSets.addItem", { testSetId, testCaseId: tc3, customFieldValues: [envParam] });

    let detail = await rpc(tenant.cookie, "GET", "testSets.get", { id: testSetId });
    expect(detail.data.items.map((i: any) => i.testCaseId)).toEqual([tc1, tc2, tc3]);

    // Move the third entry up once - now second.
    const reordered = await rpc(tenant.cookie, "POST", "testSets.reorderItem", {
      testSetId,
      itemId: item3.data.id,
      direction: "up",
    });
    expect(reordered.ok).toBe(true);
    detail = await rpc(tenant.cookie, "GET", "testSets.get", { id: testSetId });
    expect(detail.data.items.map((i: any) => i.testCaseId)).toEqual([tc1, tc3, tc2]);

    const removed = await rpc(tenant.cookie, "POST", "testSets.removeItem", { itemId: item1.data.id });
    expect(removed.ok).toBe(true);
    detail = await rpc(tenant.cookie, "GET", "testSets.get", { id: testSetId });
    expect(detail.data.items.map((i: any) => i.testCaseId)).toEqual([tc3, tc2]);
  });

  test("a test set can only contain test cases from its own product", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const productA = await rpc(tenant.cookie, "POST", "products.create", { name: "A" });
    const productB = await rpc(tenant.cookie, "POST", "products.create", { name: "B" });
    const testCaseInB = await createTestCase(tenant, productB.data.id, "Other product's test");

    const setInA = await rpc(tenant.cookie, "POST", "testSets.create", { productId: productA.data.id, name: "A's set" });
    const rejected = await rpc(tenant.cookie, "POST", "testSets.addItem", {
      testSetId: setInA.data.id,
      testCaseId: testCaseInB,
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.error?.message).toMatch(/own product/);
  });

  test("a run started from a test set item is tracked on that item and shows up as in progress", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "P" });
    const productId = product.data.id;
    const testCaseId = await createTestCase(tenant, productId, "Login works");
    const env = await defaultRunParam(tenant.cookie);

    const set = await rpc(tenant.cookie, "POST", "testSets.create", { productId, name: "Regression" });
    const item = await rpc(tenant.cookie, "POST", "testSets.addItem", {
      testSetId: set.data.id,
      testCaseId,
      customFieldValues: [env],
    });

    let detail = await rpc(tenant.cookie, "GET", "testSets.get", { id: set.data.id });
    expect(detail.data.items[0].lastExecution).toBeNull();

    const started = await rpc(tenant.cookie, "POST", "testCases.startExecution", {
      testCaseId,
      customFieldValues: [env],
      testSetItemId: item.data.id,
    });
    expect(started.ok).toBe(true);

    detail = await rpc(tenant.cookie, "GET", "testSets.get", { id: set.data.id });
    expect(detail.data.items[0].lastExecution).toMatchObject({
      id: started.data.execution.id,
      status: "in_progress",
      completedAt: null,
      executedByName: "E2E Tester",
    });

    // Completing the run flips the item's lastExecution to the rollup result.
    const stepExecutionId = started.data.stepExecutions[0].id;
    await rpc(tenant.cookie, "POST", "testCases.recordStepResult", {
      testStepExecutionId: stepExecutionId,
      actualResult: "Worked",
      status: "pass",
    });
    const completed = await rpc(tenant.cookie, "POST", "testCases.completeExecution", {
      executionId: started.data.execution.id,
    });
    expect(completed.ok).toBe(true);

    detail = await rpc(tenant.cookie, "GET", "testSets.get", { id: set.data.id });
    expect(detail.data.items[0].lastExecution.status).toBe("pass");
    expect(detail.data.items[0].lastExecution.completedAt).not.toBeNull();
  });

  test("the same test case placed twice in a set can be run independently under each placement", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "P" });
    const productId = product.data.id;
    const testCaseId = await createTestCase(tenant, productId, "Cross-env test");
    const env = await defaultRunParam(tenant.cookie);

    const set = await rpc(tenant.cookie, "POST", "testSets.create", { productId, name: "Cross-env" });
    const item1 = await rpc(tenant.cookie, "POST", "testSets.addItem", { testSetId: set.data.id, testCaseId, customFieldValues: [env] });
    const item2 = await rpc(tenant.cookie, "POST", "testSets.addItem", { testSetId: set.data.id, testCaseId, customFieldValues: [env] });

    await rpc(tenant.cookie, "POST", "testCases.startExecution", {
      testCaseId,
      customFieldValues: [env],
      testSetItemId: item1.data.id,
    });

    const detail = await rpc(tenant.cookie, "GET", "testSets.get", { id: set.data.id });
    const row1 = detail.data.items.find((i: any) => i.id === item1.data.id);
    const row2 = detail.data.items.find((i: any) => i.id === item2.data.id);
    expect(row1.lastExecution).not.toBeNull();
    expect(row2.lastExecution).toBeNull();
  });

  test("removing a test set item detaches but doesn't delete its execution history", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "P" });
    const productId = product.data.id;
    const testCaseId = await createTestCase(tenant, productId, "To be removed");
    const env = await defaultRunParam(tenant.cookie);

    const set = await rpc(tenant.cookie, "POST", "testSets.create", { productId, name: "Temp set" });
    const item = await rpc(tenant.cookie, "POST", "testSets.addItem", { testSetId: set.data.id, testCaseId, customFieldValues: [env] });
    const started = await rpc(tenant.cookie, "POST", "testCases.startExecution", {
      testCaseId,
      customFieldValues: [env],
      testSetItemId: item.data.id,
    });
    expect(started.ok).toBe(true);

    const removed = await rpc(tenant.cookie, "POST", "testSets.removeItem", { itemId: item.data.id });
    expect(removed.ok).toBe(true);

    const testCaseDetail = await rpc(tenant.cookie, "GET", "testCases.get", { id: testCaseId });
    expect(testCaseDetail.data.executions.map((e: any) => e.id)).toContain(started.data.execution.id);
  });

  test("starting a run rejects a test set item that doesn't match the given test case", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "P" });
    const productId = product.data.id;
    const testCaseA = await createTestCase(tenant, productId, "A");
    const testCaseB = await createTestCase(tenant, productId, "B");
    const env = await defaultRunParam(tenant.cookie);

    const set = await rpc(tenant.cookie, "POST", "testSets.create", { productId, name: "Mismatch" });
    const item = await rpc(tenant.cookie, "POST", "testSets.addItem", { testSetId: set.data.id, testCaseId: testCaseA, customFieldValues: [env] });

    const mismatched = await rpc(tenant.cookie, "POST", "testCases.startExecution", {
      testCaseId: testCaseB,
      customFieldValues: [env],
      testSetItemId: item.data.id,
    });
    expect(mismatched.ok).toBe(false);
    expect(mismatched.error?.message).toMatch(/does not match/);
  });

  test("a round scopes each item's lastExecution to that round, not the set's all-time history", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "P" });
    const productId = product.data.id;
    const tc1 = await createTestCase(tenant, productId, "First");
    const tc2 = await createTestCase(tenant, productId, "Second");
    const env = await defaultRunParam(tenant.cookie);

    const set = await rpc(tenant.cookie, "POST", "testSets.create", { productId, name: "Release rounds" });
    const item1 = await rpc(tenant.cookie, "POST", "testSets.addItem", { testSetId: set.data.id, testCaseId: tc1, customFieldValues: [env] });
    const item2 = await rpc(tenant.cookie, "POST", "testSets.addItem", { testSetId: set.data.id, testCaseId: tc2, customFieldValues: [env] });

    // Run item1 with no round selected (ad-hoc, all-time) - this is history a later round
    // must not inherit.
    await rpc(tenant.cookie, "POST", "testCases.startExecution", { testCaseId: tc1, customFieldValues: [env], testSetItemId: item1.data.id });

    const round1 = await rpc(tenant.cookie, "POST", "testSets.startRound", { testSetId: set.data.id, label: "Release 1" });
    expect(round1.ok).toBe(true);
    expect(round1.data.label).toBe("Release 1");

    // Nothing has run *in this round* yet - both items show not-run here even though
    // item1 has all-time history.
    let roundDetail = await rpc(tenant.cookie, "GET", "testSets.getRound", { id: round1.data.id });
    expect(roundDetail.data.items.every((i: any) => i.lastExecution === null)).toBe(true);

    // The set's own all-time view still shows item1's earlier run, untouched by the round.
    const allTime = await rpc(tenant.cookie, "GET", "testSets.get", { id: set.data.id });
    expect(allTime.data.items.find((i: any) => i.id === item1.data.id).lastExecution).not.toBeNull();

    await rpc(tenant.cookie, "POST", "testCases.startExecution", {
      testCaseId: tc1,
      customFieldValues: [env],
      testSetItemId: item1.data.id,
      testSetRoundId: round1.data.id,
    });

    roundDetail = await rpc(tenant.cookie, "GET", "testSets.getRound", { id: round1.data.id });
    const row1 = roundDetail.data.items.find((i: any) => i.id === item1.data.id);
    const row2 = roundDetail.data.items.find((i: any) => i.id === item2.data.id);
    expect(row1.lastExecution).not.toBeNull();
    expect(row2.lastExecution).toBeNull();
  });

  test("re-running the same item twice within one round keeps only the latest result", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "P" });
    const productId = product.data.id;
    const testCaseId = await createTestCase(tenant, productId, "Flaky");
    const env = await defaultRunParam(tenant.cookie);

    const set = await rpc(tenant.cookie, "POST", "testSets.create", { productId, name: "Latest wins" });
    const item = await rpc(tenant.cookie, "POST", "testSets.addItem", { testSetId: set.data.id, testCaseId, customFieldValues: [env] });
    const round = await rpc(tenant.cookie, "POST", "testSets.startRound", { testSetId: set.data.id });

    const first = await rpc(tenant.cookie, "POST", "testCases.startExecution", {
      testCaseId,
      customFieldValues: [env],
      testSetItemId: item.data.id,
      testSetRoundId: round.data.id,
    });
    const second = await rpc(tenant.cookie, "POST", "testCases.startExecution", {
      testCaseId,
      customFieldValues: [env],
      testSetItemId: item.data.id,
      testSetRoundId: round.data.id,
    });
    expect(second.data.execution.id).not.toBe(first.data.execution.id);

    const roundDetail = await rpc(tenant.cookie, "GET", "testSets.getRound", { id: round.data.id });
    expect(roundDetail.data.items[0].lastExecution.id).toBe(second.data.execution.id);
  });

  test("listRounds rolls up pass/fail/not-run counts per round using the set's current item count", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "P" });
    const productId = product.data.id;
    const tc1 = await createTestCase(tenant, productId, "One");
    const tc2 = await createTestCase(tenant, productId, "Two");
    const env = await defaultRunParam(tenant.cookie);

    const set = await rpc(tenant.cookie, "POST", "testSets.create", { productId, name: "Rollup" });
    const item1 = await rpc(tenant.cookie, "POST", "testSets.addItem", { testSetId: set.data.id, testCaseId: tc1, customFieldValues: [env] });
    await rpc(tenant.cookie, "POST", "testSets.addItem", { testSetId: set.data.id, testCaseId: tc2, customFieldValues: [env] });

    const round = await rpc(tenant.cookie, "POST", "testSets.startRound", { testSetId: set.data.id, label: "Release 1" });
    const started = await rpc(tenant.cookie, "POST", "testCases.startExecution", {
      testCaseId: tc1,
      customFieldValues: [env],
      testSetItemId: item1.data.id,
      testSetRoundId: round.data.id,
    });
    await rpc(tenant.cookie, "POST", "testCases.recordStepResult", {
      testStepExecutionId: started.data.stepExecutions[0].id,
      actualResult: "ok",
      status: "pass",
    });
    await rpc(tenant.cookie, "POST", "testCases.completeExecution", { executionId: started.data.execution.id });

    const rounds = await rpc(tenant.cookie, "GET", "testSets.listRounds", { testSetId: set.data.id });
    expect(rounds.ok).toBe(true);
    expect(rounds.data).toMatchObject([{ id: round.data.id, itemCount: 2, passCount: 1, notRunCount: 1, failCount: 0, blockedCount: 0 }]);
  });

  test("a set with no round started behaves exactly as before", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const product = await rpc(tenant.cookie, "POST", "products.create", { name: "P" });
    const productId = product.data.id;
    const testCaseId = await createTestCase(tenant, productId, "Ad hoc");
    const env = await defaultRunParam(tenant.cookie);

    const set = await rpc(tenant.cookie, "POST", "testSets.create", { productId, name: "No rounds" });
    const item = await rpc(tenant.cookie, "POST", "testSets.addItem", { testSetId: set.data.id, testCaseId, customFieldValues: [env] });

    const rounds = await rpc(tenant.cookie, "GET", "testSets.listRounds", { testSetId: set.data.id });
    expect(rounds.data).toEqual([]);

    const started = await rpc(tenant.cookie, "POST", "testCases.startExecution", {
      testCaseId,
      customFieldValues: [env],
      testSetItemId: item.data.id,
    });
    expect(started.ok).toBe(true);

    const detail = await rpc(tenant.cookie, "GET", "testSets.get", { id: set.data.id });
    expect(detail.data.items[0].lastExecution).toMatchObject({ id: started.data.execution.id, status: "in_progress" });
  });
});

describe("e2e: email verification on registration", () => {
  test("registering starts a user unverified and still sends a verification email (REQUIRE_EMAIL_VERIFICATION=false default)", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);

    const sql = new SQL(PG_SUPERUSER_URL);
    const [row] = await sql`select email_verified from "user" where id = ${tenant.userId}`;
    await sql.close();
    expect(row.email_verified).toBe(false);

    // Soft gate: registration already returned an authenticated session despite being
    // unverified - a protected call succeeds immediately.
    const me = await rpc(tenant.cookie, "GET", "settings.get");
    expect(me.ok).toBe(true);

    await getVerificationLink(tenant.email);
  }, 20000);

  test("clicking the emailed verification link marks the user verified", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const link = await getVerificationLink(tenant.email);

    const res = await fetch(link, { redirect: "manual" });
    expect([200, 302]).toContain(res.status);

    const sql = new SQL(PG_SUPERUSER_URL);
    const [row] = await sql`select email_verified from "user" where id = ${tenant.userId}`;
    await sql.close();
    expect(row.email_verified).toBe(true);
  }, 20000);

  test("POST /api/auth/send-verification-email resends the link", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    await getVerificationLink(tenant.email); // drain the sign-up email first

    const res = await fetch(`${BASE_URL}/api/auth/send-verification-email`, {
      method: "POST",
      // better-auth's CSRF check requires a same-origin Origin header on any request that
      // carries a session cookie (a real browser's fetch sends this automatically; a bare
      // curl/fetch from a test script has to set it explicitly).
      headers: { "Content-Type": "application/json", Cookie: tenant.cookie, Origin: BASE_URL },
      body: JSON.stringify({ email: tenant.email, callbackURL: "/" }),
    });
    expect(res.ok).toBe(true);

    const link = await getVerificationLink(tenant.email);
    expect(link).toContain("verify-email");
  }, 20000);
});

describe("e2e: org roles, invitations, and system admin", () => {
  test("the first user of a newly-registered tenant is an admin", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const list = await rpc(tenant.cookie, "GET", "members.list");
    expect(list.ok).toBe(true);
    const self = list.data.members.find((m: { id: string }) => m.id === tenant.userId);
    expect(self.role).toBe("admin");
  });

  test("invite -> accept produces a member with the offered role, emailVerified already true, and an immediately usable session", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const inviteeEmail = `e2e-invitee-${uniqueSuffix()}@example.com`;

    const invite = await rpc(tenant.cookie, "POST", "members.invite", { email: inviteeEmail, role: "member" });
    expect(invite.ok).toBe(true);

    const link = await getInvitationLink(inviteeEmail);
    const url = new URL(link);

    const res = await fetch(`${BASE_URL}/api/accept-invite`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: url.searchParams.get("token"),
        tenantId: url.searchParams.get("tenant"),
        name: "Invited Person",
        password: "correct horse battery staple",
      }),
    });
    expect(res.ok).toBe(true);
    const cookie = parseCookie(res);
    const body = (await res.json()) as { user: { id: string; role: string; tenantId: string } };
    expect(body.user.role).toBe("member");
    expect(body.user.tenantId).toBe(tenant.tenantId);

    const sql = new SQL(PG_SUPERUSER_URL);
    const [row] = await sql`select email_verified from "user" where id = ${body.user.id}`;
    await sql.close();
    expect(row.email_verified).toBe(true);

    // Usable immediately - no separate verify-email step required.
    const me = await rpc(cookie, "GET", "members.list");
    expect(me.ok).toBe(true);
  }, 20000);

  test("a non-admin member gets FORBIDDEN on invite/updateRole/remove", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const memberEmail = `e2e-member-${uniqueSuffix()}@example.com`;

    await rpc(tenant.cookie, "POST", "members.invite", { email: memberEmail, role: "member" });
    const link = await getInvitationLink(memberEmail);
    const url = new URL(link);
    const acceptRes = await fetch(`${BASE_URL}/api/accept-invite`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: url.searchParams.get("token"),
        tenantId: url.searchParams.get("tenant"),
        name: "Regular Member",
        password: "correct horse battery staple",
      }),
    });
    const memberCookie = parseCookie(acceptRes);
    const memberBody = (await acceptRes.json()) as { user: { id: string } };

    const inviteAttempt = await rpc(memberCookie, "POST", "members.invite", {
      email: `e2e-other-${uniqueSuffix()}@example.com`,
      role: "member",
    });
    expect(inviteAttempt.status).toBe(403);

    const roleAttempt = await rpc(memberCookie, "POST", "members.updateRole", {
      userId: tenant.userId,
      role: "member",
    });
    expect(roleAttempt.status).toBe(403);

    const removeAttempt = await rpc(memberCookie, "POST", "members.remove", { userId: memberBody.user.id });
    expect(removeAttempt.status).toBe(403);
  }, 20000);

  test("removing a member blocks their further access", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const memberEmail = `e2e-removed-${uniqueSuffix()}@example.com`;

    await rpc(tenant.cookie, "POST", "members.invite", { email: memberEmail, role: "member" });
    const link = await getInvitationLink(memberEmail);
    const url = new URL(link);
    const acceptRes = await fetch(`${BASE_URL}/api/accept-invite`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: url.searchParams.get("token"),
        tenantId: url.searchParams.get("tenant"),
        name: "Soon Removed",
        password: "correct horse battery staple",
      }),
    });
    const memberCookie = parseCookie(acceptRes);
    const memberBody = (await acceptRes.json()) as { user: { id: string } };

    const beforeRemoval = await rpc(memberCookie, "GET", "members.list");
    expect(beforeRemoval.ok).toBe(true);

    const removed = await rpc(tenant.cookie, "POST", "members.remove", { userId: memberBody.user.id });
    expect(removed.ok).toBe(true);

    const afterRemoval = await rpc(memberCookie, "GET", "members.list");
    expect(afterRemoval.status).toBe(403);
  }, 20000);

  test("a non-system-admin gets FORBIDDEN from admin.* routes", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const res = await rpc(tenant.cookie, "GET", "admin.listTenants");
    expect(res.status).toBe(403);
  });

  test("system admin can list tenants and suspend one; a suspended tenant's user is blocked", async () => {
    const adminTenant = await registerTenant(`E2E Admin Org ${uniqueSuffix()}`);
    const targetTenant = await registerTenant(`E2E Target Org ${uniqueSuffix()}`);

    // There's no HTTP path to become a system admin, by design - see
    // scripts/set-system-admin.ts. Flip it directly, the same way other tests reach into
    // Postgres directly for things outside the HTTP surface.
    const sql = new SQL(PG_SUPERUSER_URL);
    await sql`update "user" set is_system_admin = true where id = ${adminTenant.userId}`;
    await sql.close();

    const list = await rpc(adminTenant.cookie, "GET", "admin.listTenants");
    expect(list.ok).toBe(true);
    expect(list.data.some((t: { id: string }) => t.id === targetTenant.tenantId)).toBe(true);

    const suspend = await rpc(adminTenant.cookie, "POST", "admin.setTenantSuspended", {
      tenantId: targetTenant.tenantId,
      suspended: true,
    });
    expect(suspend.ok).toBe(true);

    const blocked = await rpc(targetTenant.cookie, "GET", "members.list");
    expect(blocked.status).toBe(403);
  });
});

describe("e2e: authorization hardening", () => {
  /** Shared setup: an org with its admin plus one accepted, plain-member invitee. */
  async function orgWithMember(label: string) {
    const admin = await registerTenant(`E2E ${label} ${uniqueSuffix()}`);
    const memberEmail = `e2e-${label.toLowerCase()}-${uniqueSuffix()}@example.com`;
    const invited = await rpc(admin.cookie, "POST", "members.invite", { email: memberEmail, role: "member" });
    expect(invited.ok).toBe(true);

    const url = new URL(await getInvitationLink(memberEmail));
    const res = await fetch(`${BASE_URL}/api/accept-invite`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: url.searchParams.get("token"),
        tenantId: url.searchParams.get("tenant"),
        name: "Plain Member",
        password: "correct horse battery staple",
      }),
    });
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { user: { id: string } };
    return { admin, member: { cookie: parseCookie(res), id: body.user.id, email: memberEmail } };
  }

  // A member who can set their own `role` or `tenantId` through better-auth's generic
  // user-update endpoint makes orgAdminProcedure and RLS tenant scoping both decorative -
  // additionalFields.tenantId/role are input:true so our two in-process signUpEmail
  // callers can set them at creation, which also exposed them to /update-user.
  test("a member can't self-promote to admin via better-auth's /update-user", async () => {
    const { admin, member } = await orgWithMember("SelfPromote");

    const escalate = await fetch(`${BASE_URL}/api/auth/update-user`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: member.cookie, origin: BASE_URL },
      body: JSON.stringify({ role: "admin" }),
    });
    expect(escalate.status).toBe(404);

    // The authorization decision itself must be unchanged, not just the HTTP call refused.
    const stillForbidden = await rpc(member.cookie, "POST", "members.remove", { userId: admin.userId });
    expect(stillForbidden.status).toBe(403);

    const sql = new SQL(PG_SUPERUSER_URL);
    const [row] = await sql`select role from "user" where id = ${member.id}`;
    await sql.close();
    expect(row.role).toBe("member");
  }, 20000);

  test("a user can't move their session into another tenant via /update-user", async () => {
    const victim = await registerTenant(`E2E Victim ${uniqueSuffix()}`);
    const attacker = await registerTenant(`E2E Attacker ${uniqueSuffix()}`);

    const escalate = await fetch(`${BASE_URL}/api/auth/update-user`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: attacker.cookie, origin: BASE_URL },
      body: JSON.stringify({ tenantId: victim.tenantId }),
    });
    expect(escalate.status).toBe(404);

    // Still sees only their own org - withTenant's RLS scope follows session.tenantId.
    const list = await rpc(attacker.cookie, "GET", "members.list");
    expect(list.ok).toBe(true);
    expect(list.data.members.map((m: { email: string }) => m.email)).toEqual([attacker.email]);
  }, 20000);

  test("the public sign-up endpoint stays closed", async () => {
    const res = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", origin: BASE_URL },
      body: JSON.stringify({
        name: "Interloper",
        email: `e2e-signup-${uniqueSuffix()}@example.com`,
        password: "correct horse battery staple",
        tenantId: crypto.randomUUID(),
        role: "admin",
      }),
    });
    expect(res.status).toBe(404);
  });

  // The removed/suspended gate used to live only in protectedProcedure and (app)/layout,
  // so every route handler returning binary/redirect responses skipped it entirely.
  test("a removed member is blocked from the non-tRPC API routes too", async () => {
    const { admin, member } = await orgWithMember("RemovedRest");

    const upload = await fetch(`${BASE_URL}/api/attachments/upload`, {
      method: "POST",
      headers: { cookie: member.cookie, "content-type": "text/plain", "x-filename": "before.txt" },
      body: "before",
    });
    expect(upload.ok).toBe(true);

    expect((await rpc(admin.cookie, "POST", "members.remove", { userId: member.id })).ok).toBe(true);

    for (const [name, res] of [
      [
        "attachments/upload",
        await fetch(`${BASE_URL}/api/attachments/upload`, {
          method: "POST",
          headers: { cookie: member.cookie, "content-type": "text/plain", "x-filename": "after.txt" },
          body: "after",
        }),
      ],
      [
        "storage/upload",
        await fetch(`${BASE_URL}/api/storage/upload`, {
          method: "POST",
          headers: { cookie: member.cookie },
          body: "after",
        }),
      ],
      [
        "documents/generate",
        await fetch(`${BASE_URL}/api/documents/generate`, {
          method: "POST",
          headers: { cookie: member.cookie, "Content-Type": "application/json" },
          body: JSON.stringify({ templateId: crypto.randomUUID() }),
        }),
      ],
      [
        "reauth",
        await fetch(`${BASE_URL}/api/reauth`, {
          method: "POST",
          headers: { cookie: member.cookie, "Content-Type": "application/json" },
          body: JSON.stringify({ password: "correct horse battery staple" }),
        }),
      ],
    ] as const) {
      expect(`${name}:${res.status}`).toBe(`${name}:403`);
    }
  }, 30000);

  test("a suspended tenant's member is blocked from the non-tRPC API routes", async () => {
    const target = await registerTenant(`E2E SuspendedRest ${uniqueSuffix()}`);
    const sysAdmin = await registerTenant(`E2E SuspendAdmin ${uniqueSuffix()}`);
    const sql = new SQL(PG_SUPERUSER_URL);
    await sql`update "user" set is_system_admin = true where id = ${sysAdmin.userId}`;
    await sql.close();

    const suspend = await rpc(sysAdmin.cookie, "POST", "admin.setTenantSuspended", {
      tenantId: target.tenantId,
      suspended: true,
    });
    expect(suspend.ok).toBe(true);

    const upload = await fetch(`${BASE_URL}/api/attachments/upload`, {
      method: "POST",
      headers: { cookie: target.cookie, "content-type": "text/plain", "x-filename": "nope.txt" },
      body: "nope",
    });
    expect(upload.status).toBe(403);
  }, 20000);

  // An admin-less tenant can't invite, manage members or promote anyone, and has no
  // self-service way back - migration 023's backfill exists because of exactly that state.
  test("the last admin can't be removed or demoted", async () => {
    const { admin, member } = await orgWithMember("LastAdmin");

    const demote = await rpc(admin.cookie, "POST", "members.updateRole", { userId: admin.userId, role: "member" });
    expect(demote.status).toBe(400);
    expect(demote.error?.message).toContain("last admin");

    const remove = await rpc(admin.cookie, "POST", "members.remove", { userId: admin.userId });
    expect(remove.status).toBe(400);
    expect(remove.error?.message).toContain("last admin");

    // With a second admin in place, the original is free to go.
    expect((await rpc(admin.cookie, "POST", "members.updateRole", { userId: member.id, role: "admin" })).ok).toBe(true);
    expect((await rpc(admin.cookie, "POST", "members.remove", { userId: admin.userId })).ok).toBe(true);
  }, 20000);

  test("a failed registration leaves no orphaned tenant behind", async () => {
    const first = await registerTenant(`E2E Orphan ${uniqueSuffix()}`);
    const orgName = `E2E Orphan Retry ${uniqueSuffix()}`;

    // Same email as an existing account: registration must fail *without* having created
    // the organization row and its seeded defaults first.
    const res = await fetch(`${BASE_URL}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgName, name: "Dup", email: first.email, password: "correct horse battery staple" }),
    });
    expect(res.ok).toBe(false);

    const sql = new SQL(PG_SUPERUSER_URL);
    const rows = await sql`select id from tenants where name = ${orgName}`;
    await sql.close();
    expect(rows.length).toBe(0);
  }, 20000);

  test("membership and system-admin changes are written to the audit log", async () => {
    const { admin, member } = await orgWithMember("Audited");
    expect((await rpc(admin.cookie, "POST", "members.updateRole", { userId: member.id, role: "admin" })).ok).toBe(true);

    const sysAdmin = await registerTenant(`E2E AuditAdmin ${uniqueSuffix()}`);
    const sql = new SQL(PG_SUPERUSER_URL);
    await sql`update "user" set is_system_admin = true where id = ${sysAdmin.userId}`;
    await sql.close();

    const suspend = await rpc(sysAdmin.cookie, "POST", "admin.setTenantSuspended", {
      tenantId: admin.tenantId,
      suspended: true,
    });
    expect(suspend.ok).toBe(true);

    const sql2 = new SQL(PG_SUPERUSER_URL);
    const rows = await sql2`
      select action, actor_user_id, entity_id from audit_log
      where tenant_id = ${admin.tenantId}
        and (action like ${"member.%"} or action like ${"admin.%"})`;
    await sql2.close();

    const byAction = new Map<string, { actor_user_id: string; entity_id: string }>(
      (rows as { action: string; actor_user_id: string; entity_id: string }[]).map((r) => [r.action, r]),
    );
    expect(byAction.has("member.invited")).toBe(true);
    expect(byAction.get("member.role_changed")?.entity_id).toBe(member.id);
    // Recorded against the affected tenant, attributed to the system admin who did it.
    expect(byAction.get("admin.tenant_suspended")?.actor_user_id).toBe(sysAdmin.userId);
  }, 30000);

  test("a system admin can't revoke their own system-admin flag", async () => {
    const sysAdmin = await registerTenant(`E2E SelfRevoke ${uniqueSuffix()}`);
    const sql = new SQL(PG_SUPERUSER_URL);
    await sql`update "user" set is_system_admin = true where id = ${sysAdmin.userId}`;
    await sql.close();

    const res = await rpc(sysAdmin.cookie, "POST", "admin.setUserSystemAdmin", {
      userId: sysAdmin.userId,
      isSystemAdmin: false,
    });
    expect(res.status).toBe(400);
    expect((await rpc(sysAdmin.cookie, "GET", "admin.listTenants")).ok).toBe(true);
  }, 20000);
});

describe("e2e: integration connection hardening", () => {
  /** An org admin plus one accepted, plain-member invitee in the same tenant. */
  async function orgWithMember(label: string) {
    const admin = await registerTenant(`E2E ${label} ${uniqueSuffix()}`);
    const memberEmail = `e2e-${label.toLowerCase()}-${uniqueSuffix()}@example.com`;
    expect((await rpc(admin.cookie, "POST", "members.invite", { email: memberEmail, role: "member" })).ok).toBe(true);
    const url = new URL(await getInvitationLink(memberEmail));
    const res = await fetch(`${BASE_URL}/api/accept-invite`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: url.searchParams.get("token"),
        tenantId: url.searchParams.get("tenant"),
        name: "Plain Member",
        password: "correct horse battery staple",
      }),
    });
    expect(res.ok).toBe(true);
    return { admin, memberCookie: parseCookie(res) };
  }

  const SPIRA = {
    baseUrl: "https://spira.example.com/Services/v7_0/RestService.svc",
    apiVersion: "v7_0",
    username: "svc-alm",
    projectId: 1,
  };

  // Saving a connection keeps the stored API key when apiKey is omitted. Combined with an
  // editable base URL that made it a credential-exfiltration primitive: repoint the host,
  // omit the key, and the server posts the saved secret to whoever answers.
  test("a member can't change the Spira connection, and an admin can't redirect a saved key", async () => {
    const { admin, memberCookie } = await orgWithMember("SpiraGate");

    const saved = await rpc(admin.cookie, "POST", "spiraImport.saveConnection", {
      ...SPIRA,
      apiKey: "super-secret-spira-key",
    });
    expect(saved.ok).toBe(true);

    // A member may see the redacted connection, but not touch it.
    const visible = await rpc(memberCookie, "GET", "spiraImport.getConnection");
    expect(visible.ok).toBe(true);
    expect(visible.data.hasApiKey).toBe(true);
    expect(visible.data).not.toHaveProperty("apiKey");

    const memberWrite = await rpc(memberCookie, "POST", "spiraImport.saveConnection", {
      ...SPIRA,
      baseUrl: "https://evil.example.com",
    });
    expect(memberWrite.status).toBe(403);
    expect((await rpc(memberCookie, "POST", "spiraImport.testConnection")).status).toBe(403);

    // Even an admin has to re-type the key to point it somewhere new.
    const redirect = await rpc(admin.cookie, "POST", "spiraImport.saveConnection", {
      ...SPIRA,
      baseUrl: "https://evil.example.com",
    });
    expect(redirect.status).toBe(400);
    expect(redirect.error?.message).toContain("Re-enter the API key");

    // The stored connection is untouched by the rejected attempt.
    const after = await rpc(admin.cookie, "GET", "spiraImport.getConnection");
    expect(after.data.baseUrl).toContain("spira.example.com");

    // Editing an unrelated field without the key still works.
    expect((await rpc(admin.cookie, "POST", "spiraImport.saveConnection", { ...SPIRA, projectId: 9 })).ok).toBe(true);
  }, 30000);

  test.each([
    ["cloud metadata", "http://169.254.169.254/latest/meta-data/"],
    ["loopback", "http://127.0.0.1:3000/"],
    ["private range", "http://192.168.1.10/"],
    ["container hostname", "http://postgres:5432/"],
    ["non-http scheme", "file:///etc/passwd"],
  ])("the Spira base URL rejects %s", async (_label, baseUrl) => {
    const admin = await registerTenant(`E2E SSRF ${uniqueSuffix()}`);
    const res = await rpc(admin.cookie, "POST", "spiraImport.saveConnection", {
      ...SPIRA,
      baseUrl,
      apiKey: "k",
    });
    expect(res.status).toBe(400);
  }, 20000);

  test("a member can't change the AI connection, and switching provider needs the key again", async () => {
    const { admin, memberCookie } = await orgWithMember("AiGate");

    expect(
      (await rpc(admin.cookie, "POST", "llm.saveConnection", {
        provider: "anthropic",
        model: "claude-sonnet-5",
        apiKey: "super-secret-anthropic-key",
      })).ok,
    ).toBe(true);

    expect(
      (await rpc(memberCookie, "POST", "llm.saveConnection", {
        provider: "openai_compatible",
        model: "m",
        baseUrl: "https://evil.example.com/v1",
      })).status,
    ).toBe(403);
    expect((await rpc(memberCookie, "POST", "llm.testConnection")).status).toBe(403);

    // Switching provider redirects where the saved key gets sent, so it counts as a
    // redirect even though baseUrl was previously null.
    const switched = await rpc(admin.cookie, "POST", "llm.saveConnection", {
      provider: "openai_compatible",
      model: "m",
      baseUrl: "https://evil.example.com/v1",
    });
    expect(switched.status).toBe(400);
    expect(switched.error?.message).toContain("Re-enter the API key");
  }, 30000);

  test("a member can't change the NVD connection", async () => {
    const { memberCookie } = await orgWithMember("NvdGate");
    expect((await rpc(memberCookie, "POST", "vulnerabilities.saveConnection", { apiKey: "x" })).status).toBe(403);
    expect((await rpc(memberCookie, "POST", "vulnerabilities.testConnection")).status).toBe(403);
  }, 30000);

  // Uploaded bytes are served from this app's own origin, so anything the browser will
  // execute there runs with the viewer's session.
  test("an uploaded HTML attachment is served as an inert download, not as HTML", async () => {
    const tenant = await registerTenant(`E2E Sniff ${uniqueSuffix()}`);
    const up = await fetch(`${BASE_URL}/api/attachments/upload`, {
      method: "POST",
      headers: { cookie: tenant.cookie, "content-type": "text/html", "x-filename": "evil.html" },
      body: "<script>alert(document.domain)</script>",
    });
    expect(up.ok).toBe(true);
    const { url } = (await up.json()) as { url: string };

    const redirect = await fetch(`${BASE_URL}${url}`, { headers: { cookie: tenant.cookie }, redirect: "manual" });
    expect(redirect.status).toBe(307);
    const file = await fetch(new URL(redirect.headers.get("location")!, BASE_URL));
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("application/octet-stream");
    expect(file.headers.get("content-disposition")).toBe("attachment");
    expect(file.headers.get("x-content-type-options")).toBe("nosniff");
  }, 20000);

  test("an uploaded image is still served inline with its real type", async () => {
    const tenant = await registerTenant(`E2E Inline ${uniqueSuffix()}`);
    // Smallest valid PNG.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const up = await fetch(`${BASE_URL}/api/attachments/upload`, {
      method: "POST",
      headers: { cookie: tenant.cookie, "content-type": "image/png", "x-filename": "pixel.png" },
      body: png,
    });
    const { url } = (await up.json()) as { url: string };
    const redirect = await fetch(`${BASE_URL}${url}`, { headers: { cookie: tenant.cookie }, redirect: "manual" });
    const file = await fetch(new URL(redirect.headers.get("location")!, BASE_URL));
    expect(file.headers.get("content-type")).toBe("image/png");
    expect(file.headers.get("content-disposition")).toBeNull();
    expect(file.headers.get("x-content-type-options")).toBe("nosniff");
  }, 20000);

  test("a tampered or expired storage token is refused", async () => {
    const tenant = await registerTenant(`E2E Token ${uniqueSuffix()}`);
    const up = await fetch(`${BASE_URL}/api/attachments/upload`, {
      method: "POST",
      headers: { cookie: tenant.cookie, "content-type": "text/plain", "x-filename": "a.txt" },
      body: "hello",
    });
    const { url } = (await up.json()) as { url: string };
    const redirect = await fetch(`${BASE_URL}${url}`, { headers: { cookie: tenant.cookie }, redirect: "manual" });
    const signed = new URL(redirect.headers.get("location")!, BASE_URL);
    const token = signed.pathname.split("/").pop()!;

    // Re-sign the payload with a different key by swapping the signature half.
    const [payload] = token.split(".");
    const forged = `${payload}.${"0".repeat(64)}`;
    expect((await fetch(`${BASE_URL}/api/storage/file/${forged}`)).status).toBe(403);

    // Swap the payload for one naming a different key, keeping the original signature.
    const otherPayload = Buffer.from(
      JSON.stringify({ k: "other-tenant/secret", e: Date.now() + 60000, t: "text/plain" }),
    ).toString("base64url");
    const [, sig] = token.split(".");
    expect((await fetch(`${BASE_URL}/api/storage/file/${otherPayload}.${sig}`)).status).toBe(403);
  }, 20000);
});

describe("e2e: OTS documentation (FDA OTS guidance)", () => {
  async function setupOtsProduct(tenant: TestTenant, name = "OTS Product") {
    const product = await rpc(tenant.cookie, "POST", "products.create", { name });
    expect(product.ok).toBe(true);
    const levels = await rpc(tenant.cookie, "GET", "architecture.listLevels");
    const sw = levels.data.find((l: any) => l.code === "SWARCH");
    const item = await rpc(tenant.cookie, "POST", "architecture.create", {
      productId: product.data.id,
      levelId: sw.id,
      kind: "software_item",
      title: "Application",
    });
    expect(item.ok).toBe(true);
    return { productId: product.data.id as string, levelId: sw.id as string, itemId: item.data.node.id as string };
  }

  async function createOts(
    tenant: TestTenant,
    ctx: { productId: string; levelId: string; itemId: string },
    title: string,
    version?: string,
  ): Promise<string> {
    const node = await rpc(tenant.cookie, "POST", "architecture.create", {
      productId: ctx.productId,
      levelId: ctx.levelId,
      kind: "ots",
      parentId: ctx.itemId,
      title,
      supplier: "Vendor",
      version,
    });
    expect(node.ok).toBe(true);
    return node.data.node.id;
  }

  async function versionIds(tenant: TestTenant, nodeId: string): Promise<Record<string, string>> {
    const doc = await rpc(tenant.cookie, "GET", "ots.documentation", { nodeId });
    expect(doc.ok).toBe(true);
    return Object.fromEntries(doc.data.versions.map((v: any) => [v.version, v.id]));
  }

  test("registering seeds the FDA OTS template with optional documentation-level parameters", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const templates = await rpc(tenant.cookie, "GET", "documentTemplates.list", { scope: "ots_list" });
    expect(templates.ok).toBe(true);
    expect(templates.data.map((t: any) => t.name)).toEqual(["OTS Software Documentation"]);
    const params = templates.data[0].parameters;
    expect(params.map((p: any) => p.key)).toEqual(["documentationLevel", "documentationLevelRationale"]);
    expect(params.every((p: any) => p.isRequired === false)).toBe(true);
  });

  test("every profile field is optional; partial saves persist; non-OTS nodes are rejected; saves are audited", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const ctx = await setupOtsProduct(tenant);
    const nodeId = await createOts(tenant, ctx, "SQLite", "3.45.0");

    const empty = await rpc(tenant.cookie, "GET", "ots.documentation", { nodeId });
    expect(empty.ok).toBe(true);
    expect(empty.data.profile.intendedFunction).toBeNull();
    expect(empty.data.completeness.filled).toBe(0);

    // Saving with nothing filled in is valid - no field is required at any level.
    const blank = await rpc(tenant.cookie, "POST", "ots.updateProfile", { nodeId, fields: {} });
    expect(blank.ok).toBe(true);

    const saved = await rpc(tenant.cookie, "POST", "ots.updateProfile", {
      nodeId,
      fields: { category: "database", intendedFunction: "Local persistence of measurements", endOfSupportDate: "2030-12-31" },
    });
    expect(saved.ok).toBe(true);
    // A second partial save leaves the first save's fields alone.
    await rpc(tenant.cookie, "POST", "ots.updateProfile", { nodeId, fields: { designLimitations: "Single writer" } });
    const doc = await rpc(tenant.cookie, "GET", "ots.documentation", { nodeId });
    expect(doc.data.profile.category).toBe("database");
    expect(doc.data.profile.intendedFunction).toBe("Local persistence of measurements");
    expect(doc.data.profile.designLimitations).toBe("Single writer");
    expect(doc.data.profile.endOfSupportDate.slice(0, 10)).toBe("2030-12-31");
    expect(doc.data.completeness.filled).toBe(3);

    const badCategory = await rpc(tenant.cookie, "POST", "ots.updateProfile", { nodeId, fields: { category: "spreadsheet" } });
    expect(badCategory.ok).toBe(false);

    const notOts = await rpc(tenant.cookie, "POST", "ots.updateProfile", { nodeId: ctx.itemId, fields: { intendedFunction: "x" } });
    expect(notOts.ok).toBe(false);
    expect(notOts.error?.message).toMatch(/only valid on OTS items/);

    const sql = new SQL(PG_SUPERUSER_URL);
    const rows = await sql`select action from audit_log where entity_id = ${nodeId} and action = 'ots.profile_updated'`;
    await sql.close();
    expect(rows.length).toBe(3);
  });

  test("platform links must be other OTS items in the same product", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const ctx = await setupOtsProduct(tenant);
    const app = await createOts(tenant, ctx, "Qt", "6.7.0");
    const os = await createOts(tenant, ctx, "Windows 11 IoT Enterprise", "23H2");
    await rpc(tenant.cookie, "POST", "vulnerabilities.recordVersion", { nodeId: os, version: "24H2", patchLevel: "KB5040442" });

    const linked = await rpc(tenant.cookie, "POST", "ots.setPlatformLinks", { nodeId: app, platformNodeIds: [os] });
    expect(linked.ok).toBe(true);
    const doc = await rpc(tenant.cookie, "GET", "ots.documentation", { nodeId: app });
    expect(doc.data.platforms).toHaveLength(1);
    // The platform's *current* recorded version and patch come through - III.A.2's
    // "specific version levels ... and a complete list of any patches".
    expect(doc.data.platforms[0].currentVersion).toEqual({ version: "24H2", patchLevel: "KB5040442", upgradeDesignation: null });

    const self = await rpc(tenant.cookie, "POST", "ots.setPlatformLinks", { nodeId: app, platformNodeIds: [app] });
    expect(self.ok).toBe(false);
    const item = await rpc(tenant.cookie, "POST", "ots.setPlatformLinks", { nodeId: app, platformNodeIds: [ctx.itemId] });
    expect(item.ok).toBe(false);
    expect(item.error?.message).toMatch(/must be OTS items/);

    const other = await setupOtsProduct(tenant, "Other product");
    const foreign = await createOts(tenant, other, "Linux", "6.8");
    const crossProduct = await rpc(tenant.cookie, "POST", "ots.setPlatformLinks", { nodeId: app, platformNodeIds: [foreign] });
    expect(crossProduct.ok).toBe(false);
    expect(crossProduct.error?.message).toMatch(/same product/);
  });

  test("version identity fields and support status", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const ctx = await setupOtsProduct(tenant);
    const nodeId = await createOts(tenant, ctx, "OpenSSL");
    const recorded = await rpc(tenant.cookie, "POST", "vulnerabilities.recordVersion", {
      nodeId,
      version: "3.0.13",
      releaseDate: "2024-01-30",
      patchLevel: "p1",
      upgradeDesignation: "LTS",
      releaseNotesUrl: "https://example.com/notes",
    });
    expect(recorded.ok).toBe(true);
    const detail = await rpc(tenant.cookie, "GET", "architecture.get", { id: nodeId });
    const v = detail.data.versionHistory[0];
    expect(v.patchLevel).toBe("p1");
    expect(v.upgradeDesignation).toBe("LTS");
    expect(v.releaseDate.slice(0, 10)).toBe("2024-01-30");
    expect(v.supportStatus).toBe("in_use");

    const allowed = await rpc(tenant.cookie, "POST", "ots.setVersionStatus", { nodeId, versionId: v.id, supportStatus: "allowed" });
    expect(allowed.ok).toBe(true);

    // A version id belonging to some other OTS item is rejected.
    const otherNode = await createOts(tenant, ctx, "zlib", "1.3");
    const otherVersionId = (await versionIds(tenant, otherNode))["1.3"];
    const wrongNode = await rpc(tenant.cookie, "POST", "ots.setVersionStatus", {
      nodeId,
      versionId: otherVersionId,
      supportStatus: "retired",
    });
    expect(wrongNode.ok).toBe(false);
    expect(wrongNode.error?.message).toMatch(/do not belong to this OTS item/);
  });

  test("anomalies: an outcome needs a rationale, versions must be the item's own, register counts them", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const ctx = await setupOtsProduct(tenant);
    const nodeId = await createOts(tenant, ctx, "libusb", "1.0.26");
    const v = (await versionIds(tenant, nodeId))["1.0.26"];

    const unassessed = await rpc(tenant.cookie, "POST", "ots.createAnomaly", {
      nodeId,
      anomaly: { title: "Hotplug callback race", affectedVersionIds: [v] },
    });
    expect(unassessed.ok).toBe(true);

    const noRationale = await rpc(tenant.cookie, "POST", "ots.createAnomaly", {
      nodeId,
      anomaly: { title: "Timeout ignored", outcome: "acceptable" },
    });
    expect(noRationale.ok).toBe(false);
    expect(noRationale.error?.message).toMatch(/rationale is required/);

    const { requirementId } = await createRequirement(tenant, { productId: ctx.productId });
    const assessed = await rpc(tenant.cookie, "POST", "ots.createAnomaly", {
      nodeId,
      anomaly: {
        externalId: "#512",
        title: "Timeout ignored",
        impactEvaluation: "Device retries; no clinical impact",
        outcome: "acceptable",
        rationale: "Watchdog restarts the transfer",
        requirementIds: [requirementId],
      },
    });
    expect(assessed.ok).toBe(true);

    const otherNode = await createOts(tenant, ctx, "hidapi", "0.14");
    const foreignVersion = (await versionIds(tenant, otherNode))["0.14"];
    const wrongVersion = await rpc(tenant.cookie, "POST", "ots.createAnomaly", {
      nodeId,
      anomaly: { title: "X", affectedVersionIds: [foreignVersion] },
    });
    expect(wrongVersion.ok).toBe(false);

    const doc = await rpc(tenant.cookie, "GET", "ots.documentation", { nodeId });
    expect(doc.data.anomalies).toHaveLength(2);
    const withReq = doc.data.anomalies.find((a: any) => a.externalId === "#512");
    expect(withReq.requirements.map((r: any) => r.id)).toEqual([requirementId]);

    let register = await rpc(tenant.cookie, "GET", "ots.register", { productId: ctx.productId });
    const row = register.data.find((r: any) => r.node.id === nodeId);
    expect(row.anomalyCounts).toEqual({ total: 2, unassessed: 1, notAcceptable: 0 });
    expect(row.anomaliesReviewedAt).toBeNull();

    const reviewed = await rpc(tenant.cookie, "POST", "ots.markAnomaliesReviewed", { nodeId });
    expect(reviewed.ok).toBe(true);
    const deleted = await rpc(tenant.cookie, "POST", "ots.deleteAnomaly", { anomalyId: unassessed.data.id });
    expect(deleted.ok).toBe(true);
    register = await rpc(tenant.cookie, "GET", "ots.register", { productId: ctx.productId });
    const after = register.data.find((r: any) => r.node.id === nodeId);
    expect(after.anomalyCounts).toEqual({ total: 1, unassessed: 0, notAcceptable: 0 });
    expect(after.anomaliesReviewedAt).not.toBeNull();
    // The register spans every OTS item in the product.
    expect(register.data.map((r: any) => r.node.title).sort()).toEqual(["hidapi", "libusb"]);
  });

  test("release views: OTS changes between releases, and unresolved anomalies per release", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const ctx = await setupOtsProduct(tenant);
    const lib = await createOts(tenant, ctx, "protobuf", "3.21");
    await rpc(tenant.cookie, "POST", "vulnerabilities.recordVersion", { nodeId: lib, version: "3.25" });
    const added = await createOts(tenant, ctx, "fmt", "10.2");
    const libVersions = await versionIds(tenant, lib);
    const fmtVersion = (await versionIds(tenant, added))["10.2"];

    const r1 = await rpc(tenant.cookie, "POST", "softwareVersions.create", {
      productId: ctx.productId,
      versionNumber: "1.0",
      releaseDate: "2025-01-01",
    });
    const r2 = await rpc(tenant.cookie, "POST", "softwareVersions.create", {
      productId: ctx.productId,
      versionNumber: "2.0",
      releaseDate: "2026-01-01",
    });
    const tag = (nodeId: string, versionId: string, releaseIds: string[]) =>
      rpc(tenant.cookie, "POST", "architecture.setVersionSoftwareVersions", {
        nodeId,
        architectureNodeVersionId: versionId,
        softwareVersionIds: releaseIds,
      });
    expect((await tag(lib, libVersions["3.21"]!, [r1.data.id])).ok).toBe(true);
    expect((await tag(lib, libVersions["3.25"]!, [r2.data.id])).ok).toBe(true);
    expect((await tag(added, fmtVersion!, [r2.data.id])).ok).toBe(true);

    const changes = await rpc(tenant.cookie, "GET", "ots.releaseChanges", { productId: ctx.productId });
    expect(changes.ok).toBe(true);
    expect(changes.data.map((r: any) => r.release.versionNumber)).toEqual(["1.0", "2.0"]);
    expect(changes.data[0].added.map((c: any) => c.title)).toEqual(["protobuf"]);
    expect(changes.data[1].added.map((c: any) => c.title)).toEqual(["fmt"]);
    expect(changes.data[1].changed.map((c: any) => [c.title, c.from, c.to])).toEqual([["protobuf", "3.21", "3.25"]]);
    expect(changes.data[1].removed).toEqual([]);

    // Affects 3.21 only (fixed upstream in 3.25): listed under release 1.0, not 2.0.
    const anomaly = await rpc(tenant.cookie, "POST", "ots.createAnomaly", {
      nodeId: lib,
      anomaly: { title: "Varint overflow", affectedVersionIds: [libVersions["3.21"]], resolvedInVersion: "3.25" },
    });
    expect(anomaly.ok).toBe(true);
    // Not narrowed to any version: conservatively listed under every release that ships it.
    const unnarrowed = await rpc(tenant.cookie, "POST", "ots.createAnomaly", {
      nodeId: added,
      anomaly: { title: "Locale bug" },
    });
    expect(unnarrowed.ok).toBe(true);

    const template = await rpc(tenant.cookie, "POST", "documentTemplates.create", {
      scope: "ots_list",
      name: "Unresolved per release",
      htmlTemplate:
        "{{#each unresolvedAnomaliesByRelease}}[{{versionNumber}}:{{#each anomalies}}{{title}}@{{component.version}};{{/each}}]{{/each}}",
    });
    expect(template.ok).toBe(true);
    const preview = await rpc(tenant.cookie, "POST", "documentTemplates.previewHtml", {
      templateId: template.data.id,
      htmlTemplate:
        "{{#each unresolvedAnomaliesByRelease}}[{{versionNumber}}:{{#each anomalies}}{{title}}@{{component.version}};{{/each}}]{{/each}}",
      productId: ctx.productId,
    });
    expect(preview.ok).toBe(true);
    expect(preview.data.error).toBeNull();
    expect(preview.data.html).toContain("[1.0:Varint overflow@3.21;][2.0:Locale bug@10.2;]");
  });

  test("the seeded ots_list template and an ots_component template generate real PDFs", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const ctx = await setupOtsProduct(tenant);
    const nodeId = await createOts(tenant, ctx, "FreeRTOS", "10.6.2");
    await rpc(tenant.cookie, "POST", "ots.updateProfile", {
      nodeId,
      fields: { category: "operating_system", intendedFunction: "Task scheduling", developmentAssurance: "SafeRTOS lineage" },
    });
    await rpc(tenant.cookie, "POST", "ots.createAnomaly", {
      nodeId,
      anomaly: { title: "Tick drift", outcome: "not_applicable", rationale: "Tickless idle disabled" },
    });

    const seeded = (await rpc(tenant.cookie, "GET", "documentTemplates.list", { scope: "ots_list" })).data[0];
    const isPdf = (bytes: Uint8Array) => new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-";

    const list = await generateDocument(tenant.cookie, {
      templateId: seeded.id,
      productId: ctx.productId,
      paramValues: { documentationLevel: "Basic", documentationLevelRationale: "No probable risk of serious injury" },
    });
    expect(list.ok).toBe(true);
    expect(isPdf(list.bytes)).toBe(true);
    expect(list.contentDisposition).toContain("OTS Product - OTS Software Documentation.pdf");

    // Documentation-level parameters are optional - the seeded template renders without them.
    const withoutLevel = await generateDocument(tenant.cookie, { templateId: seeded.id, productId: ctx.productId });
    expect(withoutLevel.ok).toBe(true);

    const component = await rpc(tenant.cookie, "POST", "documentTemplates.create", {
      scope: "ots_component",
      name: "One OTS",
      htmlTemplate: "<h1>{{displayId}} {{title}}</h1><p>{{intendedFunction}}</p>{{#each anomalies}}<p>{{title}}: {{outcome}}</p>{{/each}}",
    });
    expect(component.ok).toBe(true);
    const preview = await rpc(tenant.cookie, "POST", "documentTemplates.previewHtml", {
      templateId: component.data.id,
      htmlTemplate: "{{title}}|{{category}}|{{intendedFunction}}|{{#each anomalies}}{{title}}={{outcome}}{{/each}}",
      architectureNodeId: nodeId,
    });
    expect(preview.data.html).toContain("FreeRTOS|Operating system|Task scheduling|Tick drift=Not applicable");
    const pdf = await generateDocument(tenant.cookie, { templateId: component.data.id, architectureNodeId: nodeId });
    expect(pdf.ok).toBe(true);
    expect(isPdf(pdf.bytes)).toBe(true);

    const missingTarget = await generateDocument(tenant.cookie, { templateId: component.data.id });
    expect(missingTarget.ok).toBe(false);
    expect(missingTarget.error).toMatch(/architectureNodeId is required/);
  });

  test("another tenant can't read or write an OTS item's documentation", async () => {
    const owner = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    const ctx = await setupOtsProduct(owner);
    const nodeId = await createOts(owner, ctx, "Private OTS", "1.0");
    await rpc(owner.cookie, "POST", "ots.updateProfile", { nodeId, fields: { intendedFunction: "secret" } });
    const created = await rpc(owner.cookie, "POST", "ots.createAnomaly", { nodeId, anomaly: { title: "secret bug" } });

    const intruder = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    expect((await rpc(intruder.cookie, "GET", "ots.documentation", { nodeId })).ok).toBe(false);
    expect((await rpc(intruder.cookie, "POST", "ots.updateProfile", { nodeId, fields: { intendedFunction: "x" } })).ok).toBe(false);
    expect((await rpc(intruder.cookie, "POST", "ots.deleteAnomaly", { anomalyId: created.data.id })).ok).toBe(false);
    expect((await rpc(intruder.cookie, "GET", "ots.register", { productId: ctx.productId })).data).toEqual([]);

    // And at the database level: with the intruder's tenant context set, RLS hides every
    // one of the owner's OTS rows.
    const appSql = new SQL(PG_APP_URL);
    const counts = await appSql.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${intruder.tenantId}, true)`;
      const [profiles] = await tx`select count(*)::int as n from ots_profiles where architecture_node_id = ${nodeId}`;
      const [anomalies] = await tx`select count(*)::int as n from ots_anomalies where architecture_node_id = ${nodeId}`;
      return [profiles.n, anomalies.n];
    });
    await appSql.close();
    expect(counts).toEqual([0, 0]);
  });

  // Sentinel token for createGithubClient's mock (needs ALLOW_MOCK_GITHUB_PROVIDER=1).
  async function saveMockGithubConnection(tenant: TestTenant) {
    const res = await rpc(tenant.cookie, "POST", "github.saveConnection", { token: "mock-github-token" });
    expect(res.ok).toBe(true);
    expect((await rpc(tenant.cookie, "GET", "github.getConnection")).data).toEqual({ hasToken: true });
  }

  test("GitHub issues import as unassessed known issues; re-imports skip what's already there", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    await saveMockGithubConnection(tenant);
    const ctx = await setupOtsProduct(tenant);
    const nodeId = await createOts(tenant, ctx, "SQLite", "3.45.0");
    const url = "https://github.com/acme/widget/issues?q=is:issue+is:open+label:bug";

    const preview = await rpc(tenant.cookie, "POST", "ots.previewGithubIssues", { nodeId, url });
    expect(preview.ok).toBe(true);
    expect(preview.data.query).toBe("repo:acme/widget is:issue is:open label:bug");
    expect(preview.data.issues.map((i: any) => [i.externalId, i.alreadyImported])).toEqual([
      ["acme/widget#102", false],
      ["acme/widget#101", false],
    ]);

    const pick = (i: any) => ({
      number: i.number,
      title: i.title,
      body: i.body,
      htmlUrl: i.htmlUrl,
      state: i.state,
      milestone: i.milestone,
    });
    const imported = await rpc(tenant.cookie, "POST", "ots.importGithubIssues", {
      nodeId,
      url,
      issues: preview.data.issues.map(pick),
    });
    expect(imported.ok).toBe(true);
    expect(imported.data).toEqual({ imported: 2, skipped: 0 });

    const doc = await rpc(tenant.cookie, "GET", "ots.documentation", { nodeId });
    const byId = Object.fromEntries(doc.data.anomalies.map((a: any) => [a.externalId, a]));
    expect(byId["acme/widget#101"]).toMatchObject({
      title: "Wrong result for empty input",
      sourceUrl: "https://github.com/acme/widget/issues/101",
      discoveryMethod: "Vendor issue tracker (GitHub)",
      resolvedInVersion: "2.4.1", // closed, so its milestone
      outcome: null,
    });
    expect(byId["acme/widget#102"].resolvedInVersion).toBeNull(); // still open

    const again = await rpc(tenant.cookie, "POST", "ots.previewGithubIssues", { nodeId, url });
    expect(again.data.issues.every((i: any) => i.alreadyImported)).toBe(true);
    const reimport = await rpc(tenant.cookie, "POST", "ots.importGithubIssues", {
      nodeId,
      url,
      issues: again.data.issues.map(pick),
    });
    expect(reimport.data).toEqual({ imported: 0, skipped: 2 });
    expect((await rpc(tenant.cookie, "GET", "ots.documentation", { nodeId })).data.anomalies).toHaveLength(2);

    const sql = new SQL(PG_SUPERUSER_URL);
    const audits = await sql`select payload from audit_log where entity_id = ${nodeId} and action = 'ots.anomalies_imported'`;
    await sql.close();
    expect(audits).toHaveLength(1);
    expect(JSON.parse(audits[0].payload).count).toBe(2); // jsonb comes back as a string here
  });

  test("GitHub import rejects non-GitHub URLs and issues from another repository", async () => {
    const tenant = await registerTenant(`E2E Org ${uniqueSuffix()}`);
    await saveMockGithubConnection(tenant);
    const ctx = await setupOtsProduct(tenant);
    const nodeId = await createOts(tenant, ctx, "Widget", "1.0");

    const notGithub = await rpc(tenant.cookie, "POST", "ots.previewGithubIssues", {
      nodeId,
      url: "https://gitlab.com/acme/widget/issues",
    });
    expect(notGithub.ok).toBe(false);
    expect(notGithub.error?.message).toMatch(/not a GitHub issues URL/);

    const otherRepo = await rpc(tenant.cookie, "POST", "ots.importGithubIssues", {
      nodeId,
      url: "https://github.com/acme/widget/issues",
      issues: [
        { number: 1, title: "x", body: "", htmlUrl: "https://github.com/evil/repo/issues/1", state: "open", milestone: null },
      ],
    });
    expect(otherRepo.ok).toBe(false);
    expect(otherRepo.error?.message).toMatch(/must belong to acme\/widget/);
  });
});
