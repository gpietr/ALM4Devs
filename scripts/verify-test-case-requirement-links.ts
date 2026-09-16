import {
  addTestCaseRequirementLinks,
  createOrUpdateRequirementFromImport,
  createOrUpdateTestCaseFromImport,
  createRequirement,
  getEffectiveRequirementLinks,
  recordExternalLink,
  seedDefaultLevels,
  seedDefaultStatuses,
  seedDefaultTestLevels,
} from "@galm/core";
import { createAdminDb, createAppDb, schema, withTenant } from "@galm/db";
import { loadImportedRequirementIdMap, resolveRequirementLinks } from "@galm/integrations-spira";
import { and, eq } from "drizzle-orm";

/**
 * Direct verification of the Spira test-case importer's requirement-trace-link feature
 * (backlog item 9.26) - run for real against a live database, same pattern as
 * verify-legacy-id-import.ts.
 *
 * Not covered by tests/e2e.test.ts: same reasoning as every other Spira-import script here
 * - the real end-to-end path (SpiraClient.listTestCaseRequirementLinks against a real
 * Spira server) needs a live or mocked Spira instance this project doesn't have test
 * infrastructure for. What's testable without one is everything downstream of that one
 * network call: resolveRequirementLinks's pure matching, loadImportedRequirementIdMap's
 * real DB read, and addTestCaseRequirementLinks/createOrUpdateTestCaseFromImport's
 * additive-only reconciliation, composed exactly the way runSpiraTestCaseImport composes
 * them.
 *
 * Usage: DATABASE_MIGRATION_URL=... DATABASE_URL=... bun run scripts/verify-test-case-requirement-links.ts
 */
async function main() {
  const admin = createAdminDb();
  const app = createAppDb();
  let failed = false;

  function check(label: string, condition: boolean) {
    console.log(`${condition ? "OK  " : "FAIL"} - ${label}`);
    if (!condition) failed = true;
  }

  const [tenant] = await admin
    .insert(schema.tenants)
    .values({ name: `TC Requirement Links Verification ${Date.now()}` })
    .returning();
  if (!tenant) throw new Error("failed to insert tenant");

  await withTenant(app, tenant.id, async (tx) => {
    await seedDefaultStatuses(tx, tenant.id);
    await seedDefaultLevels(tx, tenant.id);
    await seedDefaultTestLevels(tx, tenant.id);
  });

  const [product] = await withTenant(app, tenant.id, (tx) =>
    tx.insert(schema.products).values({ tenantId: tenant.id, name: "P" }).returning(),
  );
  if (!product) throw new Error("failed to insert product");

  const [author] = await admin
    .insert(schema.user)
    .values({ id: crypto.randomUUID(), tenantId: tenant.id, name: "Verifier", email: `verify-tc-links-${Date.now()}@example.com` })
    .returning();
  if (!author) throw new Error("failed to insert user");

  const [reqLevel] = await withTenant(app, tenant.id, (tx) =>
    tx.select().from(schema.levels).where(and(eq(schema.levels.tenantId, tenant.id), eq(schema.levels.kind, "requirement"))),
  );
  const [testLevel] = await withTenant(app, tenant.id, (tx) =>
    tx.select().from(schema.levels).where(and(eq(schema.levels.tenantId, tenant.id), eq(schema.levels.kind, "test"))),
  );
  if (!reqLevel || !testLevel) throw new Error("levels not seeded");

  // --- Set up two "already imported from Spira" requirements, and one requirement that's
  // --- never been imported (simulating "assume REQs are already created" - some are,
  // --- some aren't) ------------------------------------------------------------------

  const { requirement: reqA } = await withTenant(app, tenant.id, (tx) =>
    createRequirement(tx, { tenantId: tenant.id, productId: product.id, levelId: reqLevel.id, title: "Req A", description: "d", createdBy: author.id }),
  );
  const { requirement: reqB } = await withTenant(app, tenant.id, (tx) =>
    createRequirement(tx, { tenantId: tenant.id, productId: product.id, levelId: reqLevel.id, title: "Req B", description: "d", createdBy: author.id }),
  );
  await withTenant(app, tenant.id, (tx) =>
    recordExternalLink(tx, { tenantId: tenant.id, entityType: "requirement", entityId: reqA.id, source: "spira", externalId: "501" }),
  );
  await withTenant(app, tenant.id, (tx) =>
    recordExternalLink(tx, { tenantId: tenant.id, entityType: "requirement", entityId: reqB.id, source: "spira", externalId: "502" }),
  );
  // Spira requirement 503 is deliberately never imported here.

  // --- loadImportedRequirementIdMap / resolveRequirementLinks (pure resolution) --------

  const idMap = await loadImportedRequirementIdMap(app, tenant.id);
  check("loaded id map has an entry for each imported requirement", idMap.get("501") === reqA.id && idMap.get("502") === reqB.id);

  const resolved = resolveRequirementLinks([501, 502, 503], idMap);
  check(
    "resolveRequirementLinks matches imported requirements and reports the rest as unmapped",
    resolved.requirementIds.length === 2 &&
      resolved.requirementIds.includes(reqA.id) &&
      resolved.requirementIds.includes(reqB.id) &&
      resolved.unmappedRequirementIds.length === 1 &&
      resolved.unmappedRequirementIds[0] === 503,
  );

  // --- addTestCaseRequirementLinks: additive, idempotent, never deletes ---------------

  const { testCase } = await withTenant(app, tenant.id, (tx) =>
    createOrUpdateTestCaseFromImport(tx, {
      tenantId: tenant.id,
      productId: product.id,
      levelId: testLevel.id,
      title: "TC 1",
      createdBy: author.id,
      source: "spira",
      externalId: "900",
      requirementIds: [reqA.id],
      steps: [{ externalId: "9001", description: "step", expectedResult: "result", position: 1 }],
    }).then((r) => ({ testCase: r })),
  );
  check("create action reports the requested id was created", testCase.action === "created");
  check("create links the one requested requirement up front (linksAdded)", testCase.linksAdded === 1);

  const linksAfterCreate = await withTenant(app, tenant.id, (tx) => getEffectiveRequirementLinks(tx, tenant.id, testCase.testCaseId));
  check("test case is actually linked to Req A after create", linksAfterCreate.some((l) => l.id === reqA.id));

  // A human links a THIRD requirement (reqB) directly, outside the importer entirely -
  // simulates someone using the product UI, not a re-import.
  const manualAdd = await withTenant(app, tenant.id, (tx) => addTestCaseRequirementLinks(tx, tenant.id, testCase.testCaseId, [reqB.id]));
  check("a link added outside the importer is added normally", manualAdd.added === 1);

  // Re-import the same test case, now with a DIFFERENT (non-overlapping) resolved link
  // set from Spira - reqA only (as if Spira's own coverage still lists Req A, and doesn't
  // know about reqB at all, since that link was added locally, not in Spira).
  const reimport = await withTenant(app, tenant.id, (tx) =>
    createOrUpdateTestCaseFromImport(tx, {
      tenantId: tenant.id,
      productId: product.id,
      levelId: testLevel.id,
      title: "TC 1",
      createdBy: author.id,
      source: "spira",
      externalId: "900",
      requirementIds: [reqA.id],
      steps: [{ externalId: "9001", description: "step", expectedResult: "result", position: 1 }],
    }),
  );
  check("re-import with an already-linked requirement adds nothing new", reimport.linksAdded === 0);
  check("re-import with no other change reports 'unchanged'", reimport.action === "unchanged");

  const linksAfterReimport = await withTenant(app, tenant.id, (tx) => getEffectiveRequirementLinks(tx, tenant.id, testCase.testCaseId));
  check(
    "the manually-added Req B link survives a re-import that doesn't mention it - additive only, never deletes",
    linksAfterReimport.some((l) => l.id === reqA.id) && linksAfterReimport.some((l) => l.id === reqB.id),
  );

  // Re-import again, this time with a genuinely NEW requirement link from Spira
  // (simulating the requirement having been imported in the meantime).
  const { requirement: reqC } = await withTenant(app, tenant.id, (tx) =>
    createRequirement(tx, { tenantId: tenant.id, productId: product.id, levelId: reqLevel.id, title: "Req C", description: "d", createdBy: author.id }),
  );
  await withTenant(app, tenant.id, (tx) =>
    recordExternalLink(tx, { tenantId: tenant.id, entityType: "requirement", entityId: reqC.id, source: "spira", externalId: "504" }),
  );
  const reimportWithNewLink = await withTenant(app, tenant.id, (tx) =>
    createOrUpdateTestCaseFromImport(tx, {
      tenantId: tenant.id,
      productId: product.id,
      levelId: testLevel.id,
      title: "TC 1",
      createdBy: author.id,
      source: "spira",
      externalId: "900",
      requirementIds: [reqA.id, reqC.id],
      steps: [{ externalId: "9001", description: "step", expectedResult: "result", position: 1 }],
    }),
  );
  check("re-import that adds one genuinely new link reports it (linksAdded)", reimportWithNewLink.linksAdded === 1);
  check(
    "a link-only change (title/steps identical) still reports 'updated', not 'unchanged' - same fix pattern as custom fields (9.21)",
    reimportWithNewLink.action === "updated",
  );

  const finalLinks = await withTenant(app, tenant.id, (tx) => getEffectiveRequirementLinks(tx, tenant.id, testCase.testCaseId));
  check(
    "final link set is the union of every requirement ever linked - Req A, Req B (manual), and Req C (new import)",
    finalLinks.length === 3 && [reqA.id, reqB.id, reqC.id].every((id) => finalLinks.some((l) => l.id === id)),
  );

  // --- requirement import itself is untouched by any of this - sanity check that
  // --- createOrUpdateRequirementFromImport still works standalone -----------------------
  const reqImportResult = await withTenant(app, tenant.id, (tx) =>
    createOrUpdateRequirementFromImport(tx, {
      tenantId: tenant.id,
      productId: product.id,
      levelId: reqLevel.id,
      title: "Req D",
      description: "d",
      createdBy: author.id,
      source: "spira",
      externalId: "505",
    }),
  );
  check("requirement import still works unaffected by the test-case-link changes", reqImportResult.action === "created");

  if (failed) {
    console.error("\nSome checks FAILED.");
    process.exit(1);
  }
  console.log("\nAll checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Verification script crashed:", err);
  process.exit(1);
});
