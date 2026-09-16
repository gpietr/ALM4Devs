import {
  createOrUpdateRequirementFromImport,
  createRequirement,
  createTestCase,
  ensureSequenceCounterAtLeast,
  seedDefaultLevels,
  seedDefaultStatuses,
  seedDefaultTestLevels,
} from "@galm/core";
import { createAdminDb, createAppDb, schema, withTenant } from "@galm/db";
import { and, eq, sql } from "drizzle-orm";

/**
 * Direct verification of the Spira-import "legacy id" mechanism - run for real against a
 * live database, same pattern as verify-audit-immutability.ts.
 *
 * Not covered by tests/e2e.test.ts: that suite is a deliberate black-box HTTP contract
 * test against the running app, and this mechanism only exists inside
 * packages/integrations/spira's ordered-import path (runOrderedSpiraImport/
 * runOrderedSpiraTestCaseImport in import.ts/test-case-import.ts), which needs a real or
 * mocked Spira server to exercise end to end - not built here (no Spira e2e coverage
 * exists in this project at all yet). What IS testable without one is the underlying
 * mechanism those functions compose from packages/core primitives:
 * `ensureSequenceCounterAtLeast` used right before the completely ordinary
 * `createRequirement`/`createTestCase` (no special "claim" parameter needed on either -
 * see TECH_STACK.md's writeup of this feature for why the simpler design replaced an
 * earlier one that did add such a parameter), and `createOrUpdateRequirementFromImport`'s
 * existing-vs-new matching. This script exercises that composition, in the same
 * sorted-ascending order the real import functions use, including importing into a level
 * that already has items in it - update in place, add new, and gracefully roll forward
 * past any number that's already taken rather than failing the row ("duplicate IDs
 * ignored" - see the ordered-import functions' docstrings).
 *
 * Usage: DATABASE_MIGRATION_URL=... DATABASE_URL=... bun run scripts/verify-legacy-id-import.ts
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
    .values({ name: `Legacy ID Import Verification ${Date.now()}` })
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
    .values({
      id: crypto.randomUUID(),
      tenantId: tenant.id,
      name: "Verifier",
      email: `verify-legacy-id-${Date.now()}@example.com`,
    })
    .returning();
  if (!author) throw new Error("failed to insert user");

  const [reqLevel] = await withTenant(app, tenant.id, (tx) =>
    tx.select().from(schema.levels).where(and(eq(schema.levels.tenantId, tenant.id), eq(schema.levels.kind, "requirement"))),
  );
  const [testLevel] = await withTenant(app, tenant.id, (tx) =>
    tx.select().from(schema.levels).where(and(eq(schema.levels.tenantId, tenant.id), eq(schema.levels.kind, "test"))),
  );
  if (!reqLevel || !testLevel) throw new Error("levels not seeded");

  // --- Requirements: simulate an ordered import with legacy ids [104, 12, 47] --------
  // (listed out of numeric order on purpose - the real importer sorts before creating;
  // this script does the same sort here to exercise the exact composition it uses.)

  const legacyIds = [104, 12, 47].sort((a, b) => a - b); // [12, 47, 104]
  const created: number[] = [];
  for (const legacyId of legacyIds) {
    const { requirement } = await withTenant(app, tenant.id, async (tx) => {
      await ensureSequenceCounterAtLeast(tx, tenant.id, product.id, reqLevel.id, legacyId - 1);
      return createRequirement(tx, {
        tenantId: tenant.id,
        productId: product.id,
        levelId: reqLevel.id,
        title: `Legacy ${legacyId}`,
        description: "d",
        createdBy: author.id,
      });
    });
    created.push(requirement.sequenceNumber);
  }
  check("each requirement landed exactly on its own legacy number, in sorted order", JSON.stringify(created) === JSON.stringify(legacyIds));

  // Two rows in the same import batch claiming the same legacy number: the first gets
  // it, the second (processed right after, since a stable sort keeps equal elements in
  // place) rolls forward to the next available number instead of colliding.
  const dupLegacyId = 300;
  const firstOfPair = await withTenant(app, tenant.id, async (tx) => {
    await ensureSequenceCounterAtLeast(tx, tenant.id, product.id, reqLevel.id, dupLegacyId - 1);
    return createRequirement(tx, {
      tenantId: tenant.id,
      productId: product.id,
      levelId: reqLevel.id,
      title: "Dup A",
      description: "d",
      createdBy: author.id,
    });
  });
  const secondOfPair = await withTenant(app, tenant.id, async (tx) => {
    await ensureSequenceCounterAtLeast(tx, tenant.id, product.id, reqLevel.id, dupLegacyId - 1); // no-op, already past this
    return createRequirement(tx, {
      tenantId: tenant.id,
      productId: product.id,
      levelId: reqLevel.id,
      title: "Dup B",
      description: "d",
      createdBy: author.id,
    });
  });
  check("first of a duplicate legacy-id pair gets the requested number", firstOfPair.requirement.sequenceNumber === dupLegacyId);
  check(
    "second of a duplicate legacy-id pair rolls forward instead of colliding",
    secondOfPair.requirement.sequenceNumber !== dupLegacyId && secondOfPair.requirement.sequenceNumber > dupLegacyId,
  );

  // --- Importing into a level that ALREADY has items (the point of this change:          --
  // --- "let me run import if entries are already there") --------------------------------
  // At this point reqLevel already has real requirements in it (from the checks above).
  // A legacy id that collides with one of the numbers already used here - not just
  // another row in the same batch - must roll forward the same way, without erroring.

  const collidesWithExisting = await withTenant(app, tenant.id, async (tx) => {
    await ensureSequenceCounterAtLeast(tx, tenant.id, product.id, reqLevel.id, legacyIds[0]! - 1); // 11: already long past
    return createRequirement(tx, {
      tenantId: tenant.id,
      productId: product.id,
      levelId: reqLevel.id,
      title: "Collides with an already-imported item",
      description: "d",
      createdBy: author.id,
    });
  });
  check(
    "a legacy id colliding with an item that already existed in the level rolls forward too, not just same-batch duplicates",
    collidesWithExisting.requirement.sequenceNumber !== legacyIds[0],
  );

  const dupCheckReq = await withTenant(app, tenant.id, (tx) =>
    tx
      .select({ n: schema.requirements.sequenceNumber, count: sql<number>`count(*)::int` })
      .from(schema.requirements)
      .where(and(eq(schema.requirements.productId, product.id), eq(schema.requirements.levelId, reqLevel.id)))
      .groupBy(schema.requirements.sequenceNumber)
      .having(sql`count(*) > 1`),
  );
  check("no duplicate sequence numbers exist among requirements created above", dupCheckReq.length === 0);

  // --- Re-importing an already-imported row updates it in place, not a duplicate --------

  const firstImport = await withTenant(app, tenant.id, (tx) =>
    createOrUpdateRequirementFromImport(tx, {
      tenantId: tenant.id,
      productId: product.id,
      levelId: reqLevel.id,
      title: "Imported Once",
      description: "original description",
      createdBy: author.id,
      source: "spira",
      externalId: "12345",
    }),
  );
  check("first import of a Spira id creates a new requirement", firstImport.action === "created");
  const [beforeUpdate] = await withTenant(app, tenant.id, (tx) =>
    tx.select().from(schema.requirements).where(eq(schema.requirements.id, firstImport.requirementId)),
  );

  const secondImport = await withTenant(app, tenant.id, (tx) =>
    createOrUpdateRequirementFromImport(tx, {
      tenantId: tenant.id,
      productId: product.id,
      levelId: reqLevel.id,
      title: "Imported Once",
      description: "updated description",
      createdBy: author.id,
      source: "spira",
      externalId: "12345",
    }),
  );
  check("re-importing the same Spira id updates the existing requirement, not a duplicate", secondImport.action === "updated");
  check(
    "the updated requirement is the same row, not a new one",
    secondImport.requirementId === firstImport.requirementId,
  );
  const [afterUpdate] = await withTenant(app, tenant.id, (tx) =>
    tx.select().from(schema.requirements).where(eq(schema.requirements.id, firstImport.requirementId)),
  );
  check(
    "updating in place never changes the requirement's own sequence number",
    afterUpdate?.sequenceNumber === beforeUpdate?.sequenceNumber && beforeUpdate?.sequenceNumber !== undefined,
  );

  // --- Test cases: same composition, same checks -------------------------------------

  const step = { description: "<p>S</p>", expectedResult: "<p>E</p>" };

  const tcLegacyIds = [80, 5, 33].sort((a, b) => a - b); // [5, 33, 80]
  const createdTc: number[] = [];
  for (const legacyId of tcLegacyIds) {
    const { testCase } = await withTenant(app, tenant.id, async (tx) => {
      await ensureSequenceCounterAtLeast(tx, tenant.id, product.id, testLevel.id, legacyId - 1);
      return createTestCase(tx, {
        tenantId: tenant.id,
        productId: product.id,
        levelId: testLevel.id,
        testType: "verification",
        title: `Legacy TC ${legacyId}`,
        createdBy: author.id,
        steps: [step],
      });
    });
    createdTc.push(testCase.sequenceNumber);
  }
  check(
    "each test case landed exactly on its own legacy number, in sorted order",
    JSON.stringify(createdTc) === JSON.stringify(tcLegacyIds),
  );

  const collidesWithExistingTc = await withTenant(app, tenant.id, async (tx) => {
    await ensureSequenceCounterAtLeast(tx, tenant.id, product.id, testLevel.id, tcLegacyIds[0]! - 1); // 4: already long past
    return createTestCase(tx, {
      tenantId: tenant.id,
      productId: product.id,
      levelId: testLevel.id,
      testType: "verification",
      title: "Collides with an already-imported test case",
      createdBy: author.id,
      steps: [step],
    });
  });
  check(
    "a test case legacy id colliding with an already-existing one rolls forward too",
    collidesWithExistingTc.testCase.sequenceNumber !== tcLegacyIds[0],
  );

  const dupCheckTc = await withTenant(app, tenant.id, (tx) =>
    tx
      .select({ n: schema.testCases.sequenceNumber, count: sql<number>`count(*)::int` })
      .from(schema.testCases)
      .where(and(eq(schema.testCases.productId, product.id), eq(schema.testCases.levelId, testLevel.id)))
      .groupBy(schema.testCases.sequenceNumber)
      .having(sql`count(*) > 1`),
  );
  check("no duplicate sequence numbers exist among test cases created above", dupCheckTc.length === 0);

  console.log(failed ? "\nFAILED" : "\nAll checks passed.");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
