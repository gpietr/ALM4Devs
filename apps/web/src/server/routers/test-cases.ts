import { db } from "@/lib/db";
import {
  completeExecution,
  createTestCase,
  type CustomFieldValueInput,
  deleteTestCase,
  DomainError,
  getEffectiveRequirementLinks,
  getExecutionWithSteps,
  getCustomFieldValues,
  getCustomFieldValuesForEntities,
  getTestCaseWithSteps,
  getTestLevel,
  listEnvironments,
  listEvidenceForStepExecution,
  listTestLevels,
  recordStepResult,
  setCustomFieldValues,
  startExecution,
  updateTestCase,
} from "@galm/core";
import { schema, withTenant } from "@galm/db";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { protectedProcedure, router } from "../trpc";

function tenantOf(ctx: { session: { user: unknown } }): string {
  return (ctx.session.user as { tenantId: string }).tenantId;
}
function userIdOf(ctx: { session: { user: unknown } }): string {
  return (ctx.session.user as { id: string }).id;
}

function toBadRequest(err: unknown): never {
  throw new TRPCError({ code: "BAD_REQUEST", message: err instanceof Error ? err.message : "request failed" });
}

const testStepInputSchema = z.object({
  description: z.string().trim().min(1).max(20000),
  expectedResult: z.string().trim().min(1).max(20000),
  purpose: z.string().trim().max(20000).optional(),
  requirementIds: z.array(z.string().uuid()).optional(),
});

/** See the identical schema in requirements.ts for the full semantics - kept as a
 * separate copy per router rather than a shared import, same as testStepInputSchema
 * above already is for this file - each router's input schemas stay self-contained. */
const customFieldValueSchema = z.object({
  fieldId: z.string().uuid(),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
});

export const testCasesRouter = router({
  listLevels: protectedProcedure.query(async ({ ctx }) => {
    const tenantId = tenantOf(ctx);
    return withTenant(db, tenantId, (tx) => listTestLevels(tx, tenantId));
  }),

  listEnvironments: protectedProcedure.query(async ({ ctx }) => {
    const tenantId = tenantOf(ctx);
    return withTenant(db, tenantId, (tx) => listEnvironments(tx, tenantId));
  }),

  listByProduct: protectedProcedure
    .input(z.object({ productId: z.string().uuid(), levelId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      return withTenant(db, tenantId, async (tx) => {
        // Every row in this list shares input.levelId, so its code is fetched once here
        // rather than joined per row.
        const level = await getTestLevel(tx, tenantId, input.levelId);

        const rows = await tx
          .select({
            id: schema.testCases.id,
            sequenceNumber: schema.testCases.sequenceNumber,
            title: schema.testCases.title,
            testType: schema.testCases.testType,
            createdAt: schema.testCases.createdAt,
          })
          .from(schema.testCases)
          .where(
            and(
              eq(schema.testCases.tenantId, tenantId),
              eq(schema.testCases.productId, input.productId),
              eq(schema.testCases.levelId, input.levelId),
            ),
          )
          .orderBy(desc(schema.testCases.createdAt));

        // "Covers" count per test case - a quick-glance signal on the list; the full
        // linked requirements show on the test case detail page (effectiveRequirementLinks).
        const ids = rows.map((r) => r.id);
        const coversCount = new Map<string, number>();
        if (ids.length > 0) {
          const [direct, viaSteps] = await Promise.all([
            tx
              .select({ testCaseId: schema.testCaseRequirementLinks.testCaseId, requirementId: schema.testCaseRequirementLinks.requirementId })
              .from(schema.testCaseRequirementLinks)
              .where(and(eq(schema.testCaseRequirementLinks.tenantId, tenantId), inArray(schema.testCaseRequirementLinks.testCaseId, ids))),
            tx
              .select({ testCaseId: schema.testSteps.testCaseId, requirementId: schema.testStepRequirementLinks.requirementId })
              .from(schema.testStepRequirementLinks)
              .innerJoin(schema.testSteps, eq(schema.testStepRequirementLinks.testStepId, schema.testSteps.id))
              .where(and(eq(schema.testStepRequirementLinks.tenantId, tenantId), inArray(schema.testSteps.testCaseId, ids))),
          ]);
          const requirementIdsByTestCase = new Map<string, Set<string>>();
          for (const { testCaseId, requirementId } of [...direct, ...viaSteps]) {
            const set = requirementIdsByTestCase.get(testCaseId) ?? new Set<string>();
            set.add(requirementId);
            requirementIdsByTestCase.set(testCaseId, set);
          }
          for (const [testCaseId, set] of requirementIdsByTestCase) coversCount.set(testCaseId, set.size);
        }

        // For the list table's optional custom-field columns (see the column picker on
        // the product page) - one batched query for every row rather than N+1.
        const customFieldsByTestCase = await getCustomFieldValuesForEntities(tx, tenantId, "test_case", ids);

        return rows.map((r) => ({
          ...r,
          levelCode: level.code,
          coversCount: coversCount.get(r.id) ?? 0,
          customFieldValues: customFieldsByTestCase.get(r.id) ?? [],
        }));
      });
    }),

  get: protectedProcedure.input(z.object({ id: z.string().uuid() })).query(async ({ ctx, input }) => {
    const tenantId = tenantOf(ctx);
    return withTenant(db, tenantId, async (tx) => {
      const { testCase, steps } = await getTestCaseWithSteps(tx, tenantId, input.id).catch((err) => {
        throw new TRPCError({ code: "NOT_FOUND", message: err instanceof Error ? err.message : undefined });
      });
      const level = await getTestLevel(tx, tenantId, testCase.levelId);

      const stepLinks = await tx
        .select({
          testStepId: schema.testStepRequirementLinks.testStepId,
          requirementId: schema.testStepRequirementLinks.requirementId,
          title: schema.requirementVersions.title,
          sequenceNumber: schema.requirements.sequenceNumber,
          levelCode: schema.levels.code,
        })
        .from(schema.testStepRequirementLinks)
        .innerJoin(schema.requirements, eq(schema.testStepRequirementLinks.requirementId, schema.requirements.id))
        .innerJoin(schema.requirementVersions, eq(schema.requirements.currentVersionId, schema.requirementVersions.id))
        .innerJoin(schema.levels, eq(schema.requirements.levelId, schema.levels.id))
        .where(eq(schema.testStepRequirementLinks.tenantId, tenantId));

      const stepsWithLinks = steps.map((step) => ({
        ...step,
        requirementLinks: stepLinks
          .filter((l) => l.testStepId === step.id)
          .map((l) => ({ id: l.requirementId, title: l.title, sequenceNumber: l.sequenceNumber, levelCode: l.levelCode })),
      }));

      const effectiveRequirementLinks = await getEffectiveRequirementLinks(tx, tenantId, input.id);

      // Direct (case-level, not inherited via a step) links only - needed so an edit form
      // can tell "explicitly linked at the case level" apart from "linked via some step",
      // rather than pre-selecting the case-level picker with the union and silently
      // duplicating step-derived links into direct ones on save.
      const directRequirementLinks = await tx
        .select({ requirementId: schema.testCaseRequirementLinks.requirementId })
        .from(schema.testCaseRequirementLinks)
        .where(and(eq(schema.testCaseRequirementLinks.testCaseId, input.id), eq(schema.testCaseRequirementLinks.tenantId, tenantId)));

      const executions = await tx
        .select({
          id: schema.testExecutions.id,
          status: schema.testExecutions.status,
          startedAt: schema.testExecutions.startedAt,
          completedAt: schema.testExecutions.completedAt,
          environmentName: schema.testEnvironments.name,
        })
        .from(schema.testExecutions)
        .innerJoin(schema.testEnvironments, eq(schema.testExecutions.environmentId, schema.testEnvironments.id))
        .where(eq(schema.testExecutions.testCaseId, input.id))
        .orderBy(desc(schema.testExecutions.startedAt));

      const customFieldValues = await getCustomFieldValues(tx, tenantId, "test_case", input.id);

      return {
        testCase: { ...testCase, levelCode: level.code },
        steps: stepsWithLinks,
        effectiveRequirementLinks,
        directRequirementIds: directRequirementLinks.map((l) => l.requirementId),
        executions,
        customFieldValues,
      };
    });
  }),

  create: protectedProcedure
    .input(
      z.object({
        productId: z.string().uuid(),
        levelId: z.string().uuid(),
        testType: z.enum(["verification", "validation"]),
        title: z.string().trim().min(1).max(300),
        requirementIds: z.array(z.string().uuid()).optional(),
        steps: z.array(testStepInputSchema).min(1),
        customFieldValues: z.array(customFieldValueSchema).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      const userId = userIdOf(ctx);
      return withTenant(db, tenantId, (tx) =>
        createTestCase(tx, {
          tenantId,
          productId: input.productId,
          levelId: input.levelId,
          testType: input.testType,
          title: input.title,
          requirementIds: input.requirementIds,
          steps: input.steps,
          createdBy: userId,
          customFieldValues: input.customFieldValues as CustomFieldValueInput[] | undefined,
        }),
      ).catch(toBadRequest);
    }),

  /** Custom field values aren't versioned or status-gated (see custom-fields.ts) - a
   * separate, always-available mutation from update, rather than folded into it, same
   * split as requirements.ts's identical mutation. */
  updateCustomFieldValues: protectedProcedure
    .input(z.object({ testCaseId: z.string().uuid(), values: z.array(customFieldValueSchema) }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      return withTenant(db, tenantId, async (tx) => {
        const [owned] = await tx
          .select({ id: schema.testCases.id })
          .from(schema.testCases)
          .where(and(eq(schema.testCases.id, input.testCaseId), eq(schema.testCases.tenantId, tenantId)));
        if (!owned) throw new DomainError("test case not found");
        await setCustomFieldValues(tx, tenantId, "test_case", input.testCaseId, input.values as CustomFieldValueInput[]);
        return { ok: true };
      }).catch(toBadRequest);
    }),

  update: protectedProcedure
    .input(
      z.object({
        testCaseId: z.string().uuid(),
        testType: z.enum(["verification", "validation"]),
        title: z.string().trim().min(1).max(300),
        requirementIds: z.array(z.string().uuid()).optional(),
        steps: z.array(testStepInputSchema.extend({ id: z.string().uuid().optional() })).min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      const userId = userIdOf(ctx);
      return withTenant(db, tenantId, (tx) =>
        updateTestCase(tx, {
          tenantId,
          testCaseId: input.testCaseId,
          testType: input.testType,
          title: input.title,
          requirementIds: input.requirementIds,
          steps: input.steps,
          actorUserId: userId,
        }),
      ).catch(toBadRequest);
    }),

  startExecution: protectedProcedure
    .input(z.object({ testCaseId: z.string().uuid(), environmentId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      const userId = userIdOf(ctx);
      return withTenant(db, tenantId, (tx) =>
        startExecution(tx, {
          tenantId,
          testCaseId: input.testCaseId,
          environmentId: input.environmentId,
          executedBy: userId,
        }),
      ).catch(toBadRequest);
    }),

  getExecution: protectedProcedure.input(z.object({ id: z.string().uuid() })).query(async ({ ctx, input }) => {
    const tenantId = tenantOf(ctx);
    return withTenant(db, tenantId, async (tx) => {
      const { execution, stepExecutions } = await getExecutionWithSteps(tx, tenantId, input.id).catch((err) => {
        throw new TRPCError({ code: "NOT_FOUND", message: err instanceof Error ? err.message : undefined });
      });
      const stepsWithEvidence = await Promise.all(
        stepExecutions.map(async (se) => ({
          ...se,
          evidence: await listEvidenceForStepExecution(tx, tenantId, se.id),
        })),
      );
      return { execution, stepExecutions: stepsWithEvidence };
    });
  }),

  recordStepResult: protectedProcedure
    .input(
      z.object({
        testStepExecutionId: z.string().uuid(),
        actualResult: z.string().trim().min(1).max(20000),
        status: z.enum(["pass", "fail", "blocked"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      return withTenant(db, tenantId, (tx) =>
        recordStepResult(tx, {
          tenantId,
          testStepExecutionId: input.testStepExecutionId,
          actualResult: input.actualResult,
          status: input.status,
        }),
      ).catch(toBadRequest);
    }),

  completeExecution: protectedProcedure
    .input(z.object({ executionId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      const userId = userIdOf(ctx);
      return withTenant(db, tenantId, (tx) => completeExecution(tx, tenantId, input.executionId, userId)).catch(
        toBadRequest,
      );
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      const userId = userIdOf(ctx);
      await withTenant(db, tenantId, (tx) => deleteTestCase(tx, tenantId, input.id, userId)).catch(toBadRequest);
      return { ok: true };
    }),
});
