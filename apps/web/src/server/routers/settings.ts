import { db } from "@/lib/db";
import {
  createCustomFieldDefinition,
  createCustomFieldListOption,
  createEnvironment,
  createLevel,
  createTestLevel,
  type CustomFieldEntityType,
  CUSTOM_FIELD_TYPES,
  type CustomFieldType,
  deleteCustomFieldDefinition,
  deleteCustomFieldListOption,
  deleteEnvironment,
  deleteLevel,
  deleteTestLevel,
  getTenantSettings,
  listAllStatuses,
  listCustomFieldDefinitions,
  listEnvironments,
  listLevels,
  listTestLevels,
  renameCustomFieldDefinition,
  renameCustomFieldListOption,
  renameEnvironment,
  renameLevel,
  renameStatus,
  renameTestLevel,
  reorderCustomFieldDefinition,
  reorderCustomFieldListOption,
  reorderEnvironment,
  reorderLevel,
  reorderStatus,
  reorderTestLevel,
  setCustomFieldRequired,
  setStatusEnabled,
  updateLevelCode,
  updateTenantSettings,
  updateTestLevelCode,
} from "@galm/core";
import { schema, withTenant } from "@galm/db";
import { TRPCError } from "@trpc/server";
import { inArray } from "drizzle-orm";
import { z } from "zod";
import { protectedProcedure, router } from "../trpc";

const CUSTOM_FIELD_TYPE_VALUES = CUSTOM_FIELD_TYPES.map((t) => t.value) as [CustomFieldType, ...CustomFieldType[]];

function tenantOf(ctx: { session: { user: unknown } }): string {
  return (ctx.session.user as { tenantId: string }).tenantId;
}

function toBadRequest(err: unknown): never {
  throw new TRPCError({ code: "BAD_REQUEST", message: err instanceof Error ? err.message : "request failed" });
}

export const settingsRouter = router({
  get: protectedProcedure.query(async ({ ctx }) => {
    const tenantId = tenantOf(ctx);
    return withTenant(db, tenantId, async (tx) => {
      const [approval, statuses, levels, testLevels, environments] = await Promise.all([
        getTenantSettings(tx, tenantId),
        listAllStatuses(tx, tenantId),
        listLevels(tx, tenantId),
        listTestLevels(tx, tenantId),
        listEnvironments(tx, tenantId),
      ]);
      return { approval, statuses, levels, testLevels, environments };
    });
  }),

  updateApprovalSettings: protectedProcedure
    .input(
      z.object({
        requireEsignature: z.boolean().optional(),
        requireIndependentReview: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      return withTenant(db, tenantId, (tx) => updateTenantSettings(tx, tenantId, input)).catch(toBadRequest);
    }),

  renameStatus: protectedProcedure
    .input(z.object({ statusId: z.string().uuid(), name: z.string().trim().min(1).max(100) }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      return withTenant(db, tenantId, (tx) => renameStatus(tx, tenantId, input.statusId, input.name)).catch(
        toBadRequest,
      );
    }),

  setStatusEnabled: protectedProcedure
    .input(z.object({ statusId: z.string().uuid(), enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      return withTenant(db, tenantId, (tx) =>
        setStatusEnabled(tx, tenantId, input.statusId, input.enabled),
      ).catch(toBadRequest);
    }),

  reorderStatus: protectedProcedure
    .input(z.object({ statusId: z.string().uuid(), direction: z.enum(["up", "down"]) }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      return withTenant(db, tenantId, (tx) =>
        reorderStatus(tx, tenantId, input.statusId, input.direction),
      ).catch(toBadRequest);
    }),

  createLevel: protectedProcedure
    .input(z.object({ name: z.string().trim().min(1).max(100), code: z.string().trim().min(1).max(20) }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      return withTenant(db, tenantId, (tx) => createLevel(tx, tenantId, input.name, input.code)).catch(toBadRequest);
    }),

  renameLevel: protectedProcedure
    .input(z.object({ levelId: z.string().uuid(), name: z.string().trim().min(1).max(100) }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      return withTenant(db, tenantId, (tx) => renameLevel(tx, tenantId, input.levelId, input.name)).catch(
        toBadRequest,
      );
    }),

  /** The id-prefix code (SYSREQ-1, ...) - a separate mutation from renameLevel (the
   * display name), since a team might fix one without touching the other. See
   * requirementLevels.code's schema comment for what changing this does and doesn't
   * affect. */
  updateLevelCode: protectedProcedure
    .input(z.object({ levelId: z.string().uuid(), code: z.string().trim().min(1).max(20) }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      return withTenant(db, tenantId, (tx) => updateLevelCode(tx, tenantId, input.levelId, input.code)).catch(
        toBadRequest,
      );
    }),

  reorderLevel: protectedProcedure
    .input(z.object({ levelId: z.string().uuid(), direction: z.enum(["up", "down"]) }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      return withTenant(db, tenantId, (tx) =>
        reorderLevel(tx, tenantId, input.levelId, input.direction),
      ).catch(toBadRequest);
    }),

  deleteLevel: protectedProcedure
    .input(z.object({ levelId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      await withTenant(db, tenantId, (tx) => deleteLevel(tx, tenantId, input.levelId)).catch(toBadRequest);
      return { ok: true };
    }),

  createTestLevel: protectedProcedure
    .input(z.object({ name: z.string().trim().min(1).max(100), code: z.string().trim().min(1).max(20) }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      return withTenant(db, tenantId, (tx) => createTestLevel(tx, tenantId, input.name, input.code)).catch(
        toBadRequest,
      );
    }),

  renameTestLevel: protectedProcedure
    .input(z.object({ levelId: z.string().uuid(), name: z.string().trim().min(1).max(100) }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      return withTenant(db, tenantId, (tx) => renameTestLevel(tx, tenantId, input.levelId, input.name)).catch(
        toBadRequest,
      );
    }),

  updateTestLevelCode: protectedProcedure
    .input(z.object({ levelId: z.string().uuid(), code: z.string().trim().min(1).max(20) }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      return withTenant(db, tenantId, (tx) => updateTestLevelCode(tx, tenantId, input.levelId, input.code)).catch(
        toBadRequest,
      );
    }),

  reorderTestLevel: protectedProcedure
    .input(z.object({ levelId: z.string().uuid(), direction: z.enum(["up", "down"]) }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      return withTenant(db, tenantId, (tx) =>
        reorderTestLevel(tx, tenantId, input.levelId, input.direction),
      ).catch(toBadRequest);
    }),

  deleteTestLevel: protectedProcedure
    .input(z.object({ levelId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      await withTenant(db, tenantId, (tx) => deleteTestLevel(tx, tenantId, input.levelId)).catch(toBadRequest);
      return { ok: true };
    }),

  createEnvironment: protectedProcedure
    .input(z.object({ name: z.string().trim().min(1).max(100) }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      return withTenant(db, tenantId, (tx) => createEnvironment(tx, tenantId, input.name)).catch(toBadRequest);
    }),

  renameEnvironment: protectedProcedure
    .input(z.object({ environmentId: z.string().uuid(), name: z.string().trim().min(1).max(100) }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      return withTenant(db, tenantId, (tx) =>
        renameEnvironment(tx, tenantId, input.environmentId, input.name),
      ).catch(toBadRequest);
    }),

  reorderEnvironment: protectedProcedure
    .input(z.object({ environmentId: z.string().uuid(), direction: z.enum(["up", "down"]) }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      return withTenant(db, tenantId, (tx) =>
        reorderEnvironment(tx, tenantId, input.environmentId, input.direction),
      ).catch(toBadRequest);
    }),

  deleteEnvironment: protectedProcedure
    .input(z.object({ environmentId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      await withTenant(db, tenantId, (tx) => deleteEnvironment(tx, tenantId, input.environmentId)).catch(
        toBadRequest,
      );
      return { ok: true };
    }),

  /** Every defined custom field for one entity type, each with its list options embedded
   * (empty for every other field type) - the shape both the settings management UI and
   * every consumer (create forms, list-table column pickers, the Spira import mapping
   * screens) need. Used from far more than just the settings page, so it isn't nested
   * under a more specific router - see apps/web/src/app/(app)/settings/custom-fields. */
  listCustomFields: protectedProcedure
    .input(z.object({ entityType: z.enum(["requirement", "test_case"]) }))
    .query(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      return withTenant(db, tenantId, async (tx) => {
        const fields = await listCustomFieldDefinitions(tx, tenantId, input.entityType as CustomFieldEntityType);
        const listFieldIds = fields.filter((f) => f.fieldType === "list").map((f) => f.id);
        const options = listFieldIds.length
          ? await tx
              .select()
              .from(schema.customFieldListOptions)
              .where(inArray(schema.customFieldListOptions.fieldId, listFieldIds))
          : [];
        const optionsByField = new Map<string, typeof options>();
        for (const o of options) {
          if (!optionsByField.has(o.fieldId)) optionsByField.set(o.fieldId, []);
          optionsByField.get(o.fieldId)!.push(o);
        }
        return fields.map((f) => ({
          ...f,
          options: (optionsByField.get(f.id) ?? []).sort((a, b) => a.sortOrder - b.sortOrder),
        }));
      });
    }),

  createCustomField: protectedProcedure
    .input(
      z.object({
        entityType: z.enum(["requirement", "test_case"]),
        name: z.string().trim().min(1).max(100),
        fieldType: z.enum(CUSTOM_FIELD_TYPE_VALUES),
        isRequired: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      return withTenant(db, tenantId, (tx) =>
        createCustomFieldDefinition(tx, tenantId, {
          entityType: input.entityType as CustomFieldEntityType,
          name: input.name,
          fieldType: input.fieldType,
          isRequired: input.isRequired,
        }),
      ).catch(toBadRequest);
    }),

  renameCustomField: protectedProcedure
    .input(z.object({ fieldId: z.string().uuid(), name: z.string().trim().min(1).max(100) }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      return withTenant(db, tenantId, (tx) => renameCustomFieldDefinition(tx, tenantId, input.fieldId, input.name)).catch(
        toBadRequest,
      );
    }),

  setCustomFieldRequired: protectedProcedure
    .input(z.object({ fieldId: z.string().uuid(), isRequired: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      return withTenant(db, tenantId, (tx) =>
        setCustomFieldRequired(tx, tenantId, input.fieldId, input.isRequired),
      ).catch(toBadRequest);
    }),

  reorderCustomField: protectedProcedure
    .input(z.object({ fieldId: z.string().uuid(), direction: z.enum(["up", "down"]) }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      return withTenant(db, tenantId, (tx) =>
        reorderCustomFieldDefinition(tx, tenantId, input.fieldId, input.direction),
      ).catch(toBadRequest);
    }),

  deleteCustomField: protectedProcedure
    .input(z.object({ fieldId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      await withTenant(db, tenantId, (tx) => deleteCustomFieldDefinition(tx, tenantId, input.fieldId)).catch(
        toBadRequest,
      );
      return { ok: true };
    }),

  createCustomFieldOption: protectedProcedure
    .input(z.object({ fieldId: z.string().uuid(), value: z.string().trim().min(1).max(200) }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      return withTenant(db, tenantId, (tx) =>
        createCustomFieldListOption(tx, tenantId, input.fieldId, input.value),
      ).catch(toBadRequest);
    }),

  renameCustomFieldOption: protectedProcedure
    .input(z.object({ optionId: z.string().uuid(), value: z.string().trim().min(1).max(200) }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      return withTenant(db, tenantId, (tx) =>
        renameCustomFieldListOption(tx, tenantId, input.optionId, input.value),
      ).catch(toBadRequest);
    }),

  reorderCustomFieldOption: protectedProcedure
    .input(z.object({ optionId: z.string().uuid(), direction: z.enum(["up", "down"]) }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      return withTenant(db, tenantId, (tx) =>
        reorderCustomFieldListOption(tx, tenantId, input.optionId, input.direction),
      ).catch(toBadRequest);
    }),

  deleteCustomFieldOption: protectedProcedure
    .input(z.object({ optionId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      await withTenant(db, tenantId, (tx) => deleteCustomFieldListOption(tx, tenantId, input.optionId)).catch(
        toBadRequest,
      );
      return { ok: true };
    }),
});
