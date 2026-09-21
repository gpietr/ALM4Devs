import { db } from "@/lib/db";
import {
  completeExecution,
  createTestCase,
  type CustomFieldValueInput,
  deleteTestCase,
  formatItemId,
  getEffectiveRequirementLinks,
  getExecutionWithSteps,
  getCustomFieldValues,
  getCustomFieldValuesForEntities,
  getLlmConnection,
  getTestCaseWithSteps,
  getTestLevel,
  listArchitectureDisplayIdsByTestCase,
  listArchitectureLinksForTestCase,
  listEnvironments,
  listEvidenceForStepExecution,
  listRequirementsForStepSuggestions,
  listSoftwareVersionsForEntities,
  listSoftwareVersionsForEntity,
  listTestLevels,
  recordStepResult,
  replaceSoftwareVersionLinks,
  replaceTestCaseArchitectureLinks,
  sanitizeRichText,
  startExecution,
  updateTestCase,
} from "@galm/core";
import { schema, withTenant } from "@galm/db";
import { proposedStepSchema, proposeStepChanges, resolveModel } from "@galm/integrations-llm";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
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

/** Like testStepInputSchema above, but carries the editor's client-generated `key` too
 * (for the AI assist's diffing - see step-diff.ts) and has no min-length requirement,
 * since this is a snapshot of whatever's currently in the editor, not a save. */
const stepForAssistSchema = z.object({
  key: z.string(),
  description: z.string(),
  expectedResult: z.string(),
  purpose: z.string().optional(),
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

  /** Every test case in a product regardless of level - mirrors requirements.ts's
   * identical procedure. Used by the shell's "Jump to item" search, which needs to
   * match across the whole product, not just whichever level's list page is showing. */
  listAllByProduct: protectedProcedure
    .input(z.object({ productId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      return withTenant(db, tenantId, (tx) =>
        tx
          .select({
            id: schema.testCases.id,
            title: schema.testCases.title,
            levelName: schema.levels.name,
            levelCode: schema.levels.code,
            sequenceNumber: schema.testCases.sequenceNumber,
          })
          .from(schema.testCases)
          .innerJoin(schema.levels, eq(schema.testCases.levelId, schema.levels.id))
          .where(and(eq(schema.testCases.tenantId, tenantId), eq(schema.testCases.productId, input.productId)))
          .orderBy(asc(schema.levels.sortOrder), asc(schema.testCases.title)),
      );
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

        // For the list table's configurable columns (see the column picker on
        // the product page) - one batched query for every row rather than N+1.
        const customFieldsByTestCase = await getCustomFieldValuesForEntities(tx, tenantId, "test_case", ids);
        const architectureByTestCase = await listArchitectureDisplayIdsByTestCase(tx, tenantId, ids);
        const softwareVersionsByTestCase = await listSoftwareVersionsForEntities(tx, tenantId, "test_case", ids);

        return rows.map((r) => ({
          ...r,
          levelCode: level.code,
          coversCount: coversCount.get(r.id) ?? 0,
          architectureLinks: architectureByTestCase.get(r.id) ?? [],
          customFieldValues: customFieldsByTestCase.get(r.id) ?? [],
          softwareVersions: softwareVersionsByTestCase.get(r.id) ?? [],
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
      const architectureLinks = await listArchitectureLinksForTestCase(tx, tenantId, input.id);
      const softwareVersions = await listSoftwareVersionsForEntity(tx, tenantId, "test_case", input.id);

      return {
        testCase: { ...testCase, levelCode: level.code },
        steps: stepsWithLinks,
        effectiveRequirementLinks,
        directRequirementIds: directRequirementLinks.map((l) => l.requirementId),
        architectureLinks,
        executions,
        customFieldValues,
        softwareVersions,
      };
    });
  }),

  create: protectedProcedure
    .input(
      z.object({
        productId: z.string().uuid(),
        levelId: z.string().uuid(),
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
          title: input.title,
          requirementIds: input.requirementIds,
          steps: input.steps,
          createdBy: userId,
          customFieldValues: input.customFieldValues as CustomFieldValueInput[] | undefined,
        }),
      ).catch(toBadRequest);
    }),

  update: protectedProcedure
    .input(
      z.object({
        testCaseId: z.string().uuid(),
        title: z.string().trim().min(1).max(300),
        requirementIds: z.array(z.string().uuid()).optional(),
        architectureNodeIds: z.array(z.string().uuid()).optional(),
        steps: z.array(testStepInputSchema.extend({ id: z.string().uuid().optional() })).min(1),
        customFieldValues: z.array(customFieldValueSchema).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      const userId = userIdOf(ctx);
      return withTenant(db, tenantId, async (tx) => {
        const result = await updateTestCase(tx, {
          tenantId,
          testCaseId: input.testCaseId,
          title: input.title,
          requirementIds: input.requirementIds,
          steps: input.steps,
          actorUserId: userId,
          customFieldValues: input.customFieldValues as CustomFieldValueInput[] | undefined,
        });
        if (input.architectureNodeIds !== undefined) {
          await replaceTestCaseArchitectureLinks(tx, {
            tenantId,
            testCaseId: input.testCaseId,
            productId: result.testCase.productId,
            architectureNodeIds: input.architectureNodeIds,
          });
        }
        return result;
      }).catch(toBadRequest);
    }),

  /** Which software versions (releases) this test case applies to - a separate mutation
   * rather than folding into `update` above, same reasoning as requirements'
   * setSoftwareVersions (not versioned content, kept independent of the steps/title
   * dirty-tracking save flow). */
  setSoftwareVersions: protectedProcedure
    .input(
      z.object({
        testCaseId: z.string().uuid(),
        softwareVersionIds: z.array(z.string().uuid()),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      return withTenant(db, tenantId, async (tx) => {
        const [owned] = await tx
          .select({ id: schema.testCases.id, productId: schema.testCases.productId })
          .from(schema.testCases)
          .where(and(eq(schema.testCases.id, input.testCaseId), eq(schema.testCases.tenantId, tenantId)));
        if (!owned) throw new TRPCError({ code: "NOT_FOUND" });
        await replaceSoftwareVersionLinks(tx, {
          tenantId,
          entityType: "test_case",
          entityId: input.testCaseId,
          productId: owned.productId,
          softwareVersionIds: input.softwareVersionIds,
        });
        return { ok: true };
      }).catch(toBadRequest);
    }),

  startExecution: protectedProcedure
    .input(
      z.object({
        testCaseId: z.string().uuid(),
        environmentId: z.string().uuid(),
        testSetItemId: z.string().uuid().optional(),
        testSetRoundId: z.string().uuid().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      const userId = userIdOf(ctx);
      return withTenant(db, tenantId, (tx) =>
        startExecution(tx, {
          tenantId,
          testCaseId: input.testCaseId,
          environmentId: input.environmentId,
          executedBy: userId,
          testSetItemId: input.testSetItemId,
          testSetRoundId: input.testSetRoundId,
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

  /** AI-assisted step drafting (chat: instruction -> proposal -> refine/accept). Never
   * persists anything - the client stages the proposal and only the existing
   * create/update mutations above ever write test_steps rows. Never throws a TRPCError
   * for "no connection saved" or "the AI call failed" - both come back as `{ error }`,
   * same pattern as documentTemplates.previewHtml, so a transient hiccup doesn't hard-
   * fail the assist dialog. */
  suggestSteps: protectedProcedure
    .input(
      z.object({
        productId: z.string().uuid(),
        testCaseTitle: z.string().optional(),
        originalSteps: z.array(stepForAssistSchema),
        previousProposal: z.array(proposedStepSchema).optional(),
        history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() })).max(50),
        instruction: z.string().trim().min(1).max(4000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      return withTenant(db, tenantId, async (tx) => {
        const connection = await getLlmConnection(tx, tenantId);
        if (!connection) return { error: "no AI connection saved yet - set one up in Settings first" };
        const { requirements, truncated } = await listRequirementsForStepSuggestions(tx, tenantId, input.productId);
        try {
          const model = await resolveModel(connection);
          const result = await proposeStepChanges(model, {
            testCaseTitle: input.testCaseTitle,
            requirements: requirements.map((r) => ({
              id: r.id,
              itemId: formatItemId(r.levelCode, r.sequenceNumber),
              title: r.title,
              description: r.description,
              background: r.background,
            })),
            requirementsTruncated: truncated,
            originalSteps: input.originalSteps.map((s) => ({
              key: s.key,
              description: s.description,
              expectedResult: s.expectedResult,
              purpose: s.purpose ?? null,
              requirementIds: s.requirementIds ?? [],
            })),
            previousProposal: input.previousProposal,
            history: input.history,
            instruction: input.instruction,
          });
          // The model's HTML hasn't passed through the app's usual sanitize-on-write path
          // (that only happens inside createTestCase/updateTestCase, once accepted and
          // saved) - but the client renders this preview directly via RichTextView,
          // which assumes its input is already safe. Sanitize here too so an unaccepted
          // proposal can't carry a script tag or event handler into the browser,
          // regardless of what the model (or a malicious 'openai_compatible' endpoint)
          // returns; saving still re-sanitizes on accept, idempotently.
          //
          // Also drop any requirementId the model returned that wasn't actually offered
          // as context - the system prompt says to only reference ids from the list, but
          // nothing stops a model from hallucinating one, and an unfiltered bad id would
          // later hard-fail Save or the next AI request's own uuid validation. "Valid"
          // includes ids already linked on the input steps (not just the context list,
          // which is capped at 300 - see listRequirementsForStepSuggestions) so an edit
          // to a step already linked to a requirement outside that cap doesn't strip it.
          const validRequirementIds = new Set([
            ...requirements.map((r) => r.id),
            ...input.originalSteps.flatMap((s) => s.requirementIds ?? []),
          ]);
          const sanitizedUpserts = result.upserts.map((s) => ({
            ...s,
            description: sanitizeRichText(s.description),
            expectedResult: sanitizeRichText(s.expectedResult),
            requirementIds: s.requirementIds.filter((id) => validRequirementIds.has(id)),
          }));
          return {
            summary: result.summary,
            upserts: sanitizedUpserts,
            removedKeys: result.removedKeys,
            order: result.order,
            truncatedRequirements: truncated,
          };
        } catch (err) {
          return { error: err instanceof Error ? err.message : "the AI request failed" };
        }
      });
    }),
});
