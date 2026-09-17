import { db } from "@/lib/db";
import { verifyAndConsumeReauthToken } from "@/lib/reauth";
import {
  createRequirement,
  type CustomFieldValueInput,
  deleteRequirement,
  DomainError,
  editDraftVersion,
  evaluateApprovalGate,
  getCoveringTestCases,
  getCustomFieldValues,
  getCustomFieldValuesForEntities,
  getLevel,
  listEnabledStatuses,
  listLevels,
  nextAllowedCategories,
  REQUIREMENT_STATUS_CATEGORIES,
  type RequirementStatusCategory,
  setCustomFieldValues,
  transitionRequirement,
} from "@galm/core";
import { schema, withTenant } from "@galm/db";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, lt } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
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

/** Shared by requirements.create/editDraft/updateCustomFieldValues and testCases.create/
 * update - one entry per custom field the caller wants to set (or clear, by passing an
 * explicit null). See packages/core/src/custom-fields.ts's setCustomFieldValues for the
 * full semantics: every *defined* field is reconciled against this array on every call,
 * so a field simply left out is treated as cleared. */
const customFieldValueSchema = z.object({
  fieldId: z.string().uuid(),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
});

const parentRequirements = alias(schema.requirements, "parent_requirements");
const parentVersions = alias(schema.requirementVersions, "parent_versions");
const parentLevels = alias(schema.levels, "parent_requirement_levels");

export const requirementsRouter = router({
  listStatuses: protectedProcedure.query(async ({ ctx }) => {
    const tenantId = tenantOf(ctx);
    return withTenant(db, tenantId, (tx) => listEnabledStatuses(tx, tenantId));
  }),

  /** Powers the level tabs on the product page and the level dropdown when creating a
   * requirement - user-definable, see packages/core/src/requirement-levels.ts. */
  listLevels: protectedProcedure.query(async ({ ctx }) => {
    const tenantId = tenantOf(ctx);
    return withTenant(db, tenantId, (tx) => listLevels(tx, tenantId));
  }),

  /** Candidates for the "parent" dropdown when creating a requirement: same product,
   * strictly higher in the hierarchy (lower sortOrder) than the given level. */
  listParentCandidates: protectedProcedure
    .input(z.object({ productId: z.string().uuid(), levelId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      return withTenant(db, tenantId, async (tx) => {
        const level = await getLevel(tx, tenantId, input.levelId);
        return tx
          .select({
            id: schema.requirements.id,
            title: schema.requirementVersions.title,
            levelName: schema.levels.name,
            levelCode: schema.levels.code,
            sequenceNumber: schema.requirements.sequenceNumber,
          })
          .from(schema.requirements)
          .innerJoin(
            schema.requirementVersions,
            eq(schema.requirements.currentVersionId, schema.requirementVersions.id),
          )
          .innerJoin(schema.levels, eq(schema.requirements.levelId, schema.levels.id))
          .where(
            and(
              eq(schema.requirements.tenantId, tenantId),
              eq(schema.requirements.productId, input.productId),
              lt(schema.levels.sortOrder, level.sortOrder),
            ),
          )
          .orderBy(asc(schema.levels.sortOrder), asc(schema.requirementVersions.title));
      });
    }),

  /** Every requirement in a product regardless of level - used to populate requirement-
   * link pickers (test case/step creation), not the per-level product page list. */
  listAllByProduct: protectedProcedure
    .input(z.object({ productId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      return withTenant(db, tenantId, (tx) =>
        tx
          .select({
            id: schema.requirements.id,
            title: schema.requirementVersions.title,
            levelName: schema.levels.name,
            levelCode: schema.levels.code,
            sequenceNumber: schema.requirements.sequenceNumber,
          })
          .from(schema.requirements)
          .innerJoin(
            schema.requirementVersions,
            eq(schema.requirements.currentVersionId, schema.requirementVersions.id),
          )
          .innerJoin(schema.levels, eq(schema.requirements.levelId, schema.levels.id))
          .where(
            and(eq(schema.requirements.tenantId, tenantId), eq(schema.requirements.productId, input.productId)),
          )
          .orderBy(asc(schema.levels.sortOrder), asc(schema.requirementVersions.title)),
      );
    }),

  listByProduct: protectedProcedure
    .input(z.object({ productId: z.string().uuid(), levelId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      return withTenant(db, tenantId, async (tx) => {
        // Every row in this list shares input.levelId, so its code is fetched once here
        // rather than joined per row.
        const level = await getLevel(tx, tenantId, input.levelId);

        const rows = await tx
          .select({
            id: schema.requirements.id,
            sequenceNumber: schema.requirements.sequenceNumber,
            createdAt: schema.requirements.createdAt,
            title: schema.requirementVersions.title,
            versionNumber: schema.requirementVersions.versionNumber,
            statusName: schema.requirementStatuses.name,
            statusCategory: schema.requirementStatuses.category,
            parentRequirementId: schema.requirements.parentRequirementId,
            parentTitle: parentVersions.title,
          })
          .from(schema.requirements)
          .innerJoin(
            schema.requirementVersions,
            eq(schema.requirements.currentVersionId, schema.requirementVersions.id),
          )
          .innerJoin(
            schema.requirementStatuses,
            eq(schema.requirementVersions.statusId, schema.requirementStatuses.id),
          )
          .leftJoin(parentRequirements, eq(schema.requirements.parentRequirementId, parentRequirements.id))
          .leftJoin(parentVersions, eq(parentRequirements.currentVersionId, parentVersions.id))
          .where(
            and(
              eq(schema.requirements.tenantId, tenantId),
              eq(schema.requirements.productId, input.productId),
              eq(schema.requirements.levelId, input.levelId),
            ),
          )
          .orderBy(desc(schema.requirements.createdAt));

        // "Covered by" count per requirement - a quick-glance signal on the list; the full
        // linked test cases show on the requirement detail page (coveringTestCases, above).
        const ids = rows.map((r) => r.id);
        const coveredByCount = new Map<string, number>();
        if (ids.length > 0) {
          const [direct, viaSteps] = await Promise.all([
            tx
              .select({ requirementId: schema.testCaseRequirementLinks.requirementId, testCaseId: schema.testCaseRequirementLinks.testCaseId })
              .from(schema.testCaseRequirementLinks)
              .where(and(eq(schema.testCaseRequirementLinks.tenantId, tenantId), inArray(schema.testCaseRequirementLinks.requirementId, ids))),
            tx
              .select({ requirementId: schema.testStepRequirementLinks.requirementId, testCaseId: schema.testSteps.testCaseId })
              .from(schema.testStepRequirementLinks)
              .innerJoin(schema.testSteps, eq(schema.testStepRequirementLinks.testStepId, schema.testSteps.id))
              .where(and(eq(schema.testStepRequirementLinks.tenantId, tenantId), inArray(schema.testStepRequirementLinks.requirementId, ids))),
          ]);
          const testCaseIdsByRequirement = new Map<string, Set<string>>();
          for (const { requirementId, testCaseId } of [...direct, ...viaSteps]) {
            const set = testCaseIdsByRequirement.get(requirementId) ?? new Set<string>();
            set.add(testCaseId);
            testCaseIdsByRequirement.set(requirementId, set);
          }
          for (const [requirementId, set] of testCaseIdsByRequirement) coveredByCount.set(requirementId, set.size);
        }

        // For the list table's configurable columns (see the column picker on
        // the product page) - one batched query for every row rather than N+1.
        const customFieldsByRequirement = await getCustomFieldValuesForEntities(tx, tenantId, "requirement", ids);

        return rows.map((r) => ({
          ...r,
          levelCode: level.code,
          coveredByCount: coveredByCount.get(r.id) ?? 0,
          customFieldValues: customFieldsByRequirement.get(r.id) ?? [],
        }));
      });
    }),

  get: protectedProcedure.input(z.object({ id: z.string().uuid() })).query(async ({ ctx, input }) => {
    const tenantId = tenantOf(ctx);
    return withTenant(db, tenantId, async (tx) => {
      const [requirement] = await tx
        .select({
          id: schema.requirements.id,
          sequenceNumber: schema.requirements.sequenceNumber,
          productId: schema.requirements.productId,
          parentRequirementId: schema.requirements.parentRequirementId,
          levelId: schema.requirements.levelId,
          levelName: schema.levels.name,
          levelCode: schema.levels.code,
          parentTitle: parentVersions.title,
          parentSequenceNumber: parentRequirements.sequenceNumber,
          parentLevelCode: parentLevels.code,
        })
        .from(schema.requirements)
        .innerJoin(schema.levels, eq(schema.requirements.levelId, schema.levels.id))
        .leftJoin(parentRequirements, eq(schema.requirements.parentRequirementId, parentRequirements.id))
        .leftJoin(parentVersions, eq(parentRequirements.currentVersionId, parentVersions.id))
        .leftJoin(parentLevels, eq(parentRequirements.levelId, parentLevels.id))
        .where(and(eq(schema.requirements.id, input.id), eq(schema.requirements.tenantId, tenantId)));
      if (!requirement) throw new TRPCError({ code: "NOT_FOUND" });

      const versions = await tx
        .select({
          id: schema.requirementVersions.id,
          versionNumber: schema.requirementVersions.versionNumber,
          title: schema.requirementVersions.title,
          description: schema.requirementVersions.description,
          background: schema.requirementVersions.background,
          createdAt: schema.requirementVersions.createdAt,
          statusId: schema.requirementStatuses.id,
          statusName: schema.requirementStatuses.name,
          statusCategory: schema.requirementStatuses.category,
        })
        .from(schema.requirementVersions)
        .innerJoin(
          schema.requirementStatuses,
          eq(schema.requirementVersions.statusId, schema.requirementStatuses.id),
        )
        .where(eq(schema.requirementVersions.requirementId, input.id))
        .orderBy(desc(schema.requirementVersions.versionNumber));

      // Children: other requirements that trace up to this one - shown so hierarchy is
      // visible from either end, not just "who is my parent".
      const children = await tx
        .select({
          id: schema.requirements.id,
          sequenceNumber: schema.requirements.sequenceNumber,
          title: schema.requirementVersions.title,
          levelName: schema.levels.name,
          levelCode: schema.levels.code,
        })
        .from(schema.requirements)
        .innerJoin(
          schema.requirementVersions,
          eq(schema.requirements.currentVersionId, schema.requirementVersions.id),
        )
        .innerJoin(schema.levels, eq(schema.requirements.levelId, schema.levels.id))
        .where(and(eq(schema.requirements.parentRequirementId, input.id), eq(schema.requirements.tenantId, tenantId)));

      // Which test cases cover this requirement - the inverse of a test case's "Traces
      // to" (getEffectiveRequirementLinks): direct case-level links, or any of their
      // steps'.
      const coveringTestCases = await getCoveringTestCases(tx, tenantId, input.id);
      const customFieldValues = await getCustomFieldValues(tx, tenantId, "requirement", input.id);

      return { requirement, versions, children, coveringTestCases, customFieldValues };
    });
  }),

  /** Reuses packages/core's state-machine graph rather than duplicating it client-side -
   * the UI just renders whatever this says is allowed right now. */
  allowedTransitions: protectedProcedure
    .input(z.object({ requirementId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      const userId = userIdOf(ctx);
      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .select({
            statusCategory: schema.requirementStatuses.category,
            authorUserId: schema.requirementVersions.createdBy,
          })
          .from(schema.requirements)
          .innerJoin(
            schema.requirementVersions,
            eq(schema.requirements.currentVersionId, schema.requirementVersions.id),
          )
          .innerJoin(
            schema.requirementStatuses,
            eq(schema.requirementVersions.statusId, schema.requirementStatuses.id),
          )
          .where(
            and(eq(schema.requirements.id, input.requirementId), eq(schema.requirements.tenantId, tenantId)),
          );
        if (!row) throw new TRPCError({ code: "NOT_FOUND" });

        const enabledStatuses = await listEnabledStatuses(tx, tenantId);
        const enabledCategories = new Set(
          enabledStatuses.map((s) => s.category as RequirementStatusCategory),
        );
        const nameByCategory = new Map(enabledStatuses.map((s) => [s.category, s.name]));
        const fromCategory = row.statusCategory as RequirementStatusCategory;
        const isAuthor = row.authorUserId === userId;

        const allowed = await Promise.all(
          nextAllowedCategories(fromCategory, enabledCategories).map(async (category) => {
            const gate = await evaluateApprovalGate(tx, tenantId, category);
            return {
              category,
              name: nameByCategory.get(category) ?? category,
              requiresEsignature: gate.requiresEsignature,
              // Surfaced ahead of time so the UI can explain a disabled button rather
              // than just letting the mutation fail after the user clicks it.
              blockedByIndependentReview: gate.requiresIndependentReview && isAuthor,
            };
          }),
        );

        return { fromCategory, allowed };
      });
    }),

  create: protectedProcedure
    .input(
      z.object({
        productId: z.string().uuid(),
        levelId: z.string().uuid(),
        parentRequirementId: z.string().uuid().optional(),
        title: z.string().trim().min(1).max(300),
        description: z.string().trim().min(1).max(10000),
        background: z.string().trim().max(20000).optional(),
        customFieldValues: z.array(customFieldValueSchema).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      const userId = userIdOf(ctx);
      return withTenant(db, tenantId, (tx) =>
        createRequirement(tx, {
          tenantId,
          productId: input.productId,
          levelId: input.levelId,
          parentRequirementId: input.parentRequirementId ?? null,
          title: input.title,
          description: input.description,
          background: input.background,
          createdBy: userId,
          customFieldValues: input.customFieldValues as CustomFieldValueInput[] | undefined,
        }),
      ).catch(toBadRequest);
    }),

  /** Custom field values aren't stored on requirement_versions, but the UI saves them
   * with title/description via editDraft. This mutation remains for callers that need
   * to set values without touching versioned content (imports already do that
   * themselves; tests too). */
  updateCustomFieldValues: protectedProcedure
    .input(z.object({ requirementId: z.string().uuid(), values: z.array(customFieldValueSchema) }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      return withTenant(db, tenantId, async (tx) => {
        const [owned] = await tx
          .select({ id: schema.requirements.id })
          .from(schema.requirements)
          .where(and(eq(schema.requirements.id, input.requirementId), eq(schema.requirements.tenantId, tenantId)));
        if (!owned) throw new DomainError("requirement not found");
        await setCustomFieldValues(tx, tenantId, "requirement", input.requirementId, input.values as CustomFieldValueInput[]);
        return { ok: true };
      }).catch(toBadRequest);
    }),

  editDraft: protectedProcedure
    .input(
      z.object({
        requirementId: z.string().uuid(),
        title: z.string().trim().min(1).max(300),
        description: z.string().trim().min(1).max(10000),
        background: z.string().trim().max(20000).optional(),
        customFieldValues: z.array(customFieldValueSchema).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      const userId = userIdOf(ctx);
      return withTenant(db, tenantId, (tx) =>
        editDraftVersion(tx, {
          tenantId,
          requirementId: input.requirementId,
          title: input.title,
          description: input.description,
          background: input.background,
          editedBy: userId,
          customFieldValues: input.customFieldValues as CustomFieldValueInput[] | undefined,
        }),
      ).catch(toBadRequest);
    }),

  /** `reauthToken` (from POST /api/reauth) + `typedName` are required together whenever
   * the destination category needs e-signature - the domain layer (transitionRequirement)
   * is the actual source of truth for which categories those are. */
  transition: protectedProcedure
    .input(
      z.object({
        requirementId: z.string().uuid(),
        toCategory: z.enum(REQUIREMENT_STATUS_CATEGORIES),
        typedName: z.string().trim().min(1).max(200).optional(),
        reauthToken: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      const userId = userIdOf(ctx);

      let approval: { typedName: string; reauthAt: Date } | undefined;
      if (input.reauthToken) {
        if (!input.typedName) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "typed name is required for e-signature" });
        }
        let reauthAt: Date;
        try {
          reauthAt = await verifyAndConsumeReauthToken(input.reauthToken, userId);
        } catch (err) {
          throw new TRPCError({
            code: "UNAUTHORIZED",
            message: err instanceof Error ? err.message : "re-auth failed",
          });
        }
        approval = { typedName: input.typedName, reauthAt };
      }

      return withTenant(db, tenantId, (tx) =>
        transitionRequirement(tx, {
          tenantId,
          requirementId: input.requirementId,
          toCategory: input.toCategory,
          actorUserId: userId,
          approval,
        }),
      ).catch(toBadRequest);
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      const userId = userIdOf(ctx);
      await withTenant(db, tenantId, (tx) => deleteRequirement(tx, tenantId, input.id, userId)).catch(toBadRequest);
      return { ok: true };
    }),
});
