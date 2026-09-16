import { db } from "@/lib/db";
import {
  buildRequirementListDocumentContext,
  buildTestCaseDocumentContext,
  buildTestExecutionDocumentContext,
  createDocumentTemplate,
  createDocumentTemplateParameter,
  deleteDocumentTemplate,
  deleteDocumentTemplateParameter,
  type DocumentTemplateParameterType,
  type DocumentTemplateScope,
  getDocumentTemplate,
  getLevel,
  listDocumentTemplateParameters,
  listDocumentTemplates,
  renameDocumentTemplate,
  reorderDocumentTemplateParameter,
  suggestParameterKey,
  updateDocumentTemplateFilename,
  updateDocumentTemplateHtml,
  updateDocumentTemplateParameter,
} from "@galm/core";
import { schema, withTenant } from "@galm/db";
import { ensureHtmlDocument, renderFilename, renderTemplate } from "@galm/documents";
import { TRPCError } from "@trpc/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { protectedProcedure, router } from "../trpc";

function tenantOf(ctx: { session: { user: unknown } }): string {
  return (ctx.session.user as { tenantId: string }).tenantId;
}

function toBadRequest(err: unknown): never {
  throw new TRPCError({ code: "BAD_REQUEST", message: err instanceof Error ? err.message : "request failed" });
}

const SCOPES = ["test_case", "test_execution", "requirement_list"] as const;
const PARAM_TYPES = ["text", "date"] as const;

/** Template + parameter CRUD (backlog item 9.29's settings side) - generation itself is a
 * raw Next.js route (apps/web/src/app/api/documents/generate/route.ts), not a tRPC
 * procedure, since it returns a binary PDF response, not JSON (same reasoning as
 * attachments' own /api routes). */
export const documentTemplatesRouter = router({
  list: protectedProcedure
    .input(z.object({ scope: z.enum(SCOPES) }))
    .query(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      return withTenant(db, tenantId, async (tx) => {
        const templates = await listDocumentTemplates(tx, tenantId, input.scope as DocumentTemplateScope);
        return Promise.all(
          templates.map(async (t) => ({ ...t, parameters: await listDocumentTemplateParameters(tx, tenantId, t.id) })),
        );
      });
    }),

  get: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      return withTenant(db, tenantId, async (tx) => {
        const template = await getDocumentTemplate(tx, tenantId, input.id).catch((err) => {
          throw new TRPCError({ code: "NOT_FOUND", message: err instanceof Error ? err.message : undefined });
        });
        const parameters = await listDocumentTemplateParameters(tx, tenantId, input.id);
        return { ...template, parameters };
      });
    }),

  create: protectedProcedure
    .input(
      z.object({
        scope: z.enum(SCOPES),
        name: z.string().trim().min(1).max(200),
        htmlTemplate: z.string().min(1),
        filenameTemplate: z.string().max(300).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      return withTenant(db, tenantId, (tx) =>
        createDocumentTemplate(tx, tenantId, {
          scope: input.scope as DocumentTemplateScope,
          name: input.name,
          htmlTemplate: input.htmlTemplate,
          filenameTemplate: input.filenameTemplate,
        }),
      ).catch(toBadRequest);
    }),

  rename: protectedProcedure
    .input(z.object({ id: z.string().uuid(), name: z.string().trim().min(1).max(200) }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      return withTenant(db, tenantId, (tx) => renameDocumentTemplate(tx, tenantId, input.id, input.name)).catch(toBadRequest);
    }),

  updateHtml: protectedProcedure
    .input(z.object({ id: z.string().uuid(), htmlTemplate: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      return withTenant(db, tenantId, (tx) => updateDocumentTemplateHtml(tx, tenantId, input.id, input.htmlTemplate)).catch(
        toBadRequest,
      );
    }),

  updateFilename: protectedProcedure
    .input(z.object({ id: z.string().uuid(), filenameTemplate: z.string().max(300) }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      return withTenant(db, tenantId, (tx) =>
        updateDocumentTemplateFilename(tx, tenantId, input.id, input.filenameTemplate),
      ).catch(toBadRequest);
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      await withTenant(db, tenantId, (tx) => deleteDocumentTemplate(tx, tenantId, input.id)).catch(toBadRequest);
      return { ok: true };
    }),

  suggestParameterKey: protectedProcedure
    .input(z.object({ label: z.string() }))
    .query(({ input }) => ({ key: suggestParameterKey(input.label) })),

  createParameter: protectedProcedure
    .input(
      z.object({
        templateId: z.string().uuid(),
        key: z.string().trim().min(1).max(60),
        label: z.string().trim().min(1).max(200),
        type: z.enum(PARAM_TYPES),
        isRequired: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      return withTenant(db, tenantId, (tx) =>
        createDocumentTemplateParameter(tx, tenantId, input.templateId, {
          key: input.key,
          label: input.label,
          type: input.type as DocumentTemplateParameterType,
          isRequired: input.isRequired,
        }),
      ).catch(toBadRequest);
    }),

  updateParameter: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        label: z.string().trim().min(1).max(200).optional(),
        type: z.enum(PARAM_TYPES).optional(),
        isRequired: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      return withTenant(db, tenantId, (tx) =>
        updateDocumentTemplateParameter(tx, tenantId, input.id, {
          label: input.label,
          type: input.type as DocumentTemplateParameterType | undefined,
          isRequired: input.isRequired,
        }),
      ).catch(toBadRequest);
    }),

  reorderParameter: protectedProcedure
    .input(z.object({ id: z.string().uuid(), direction: z.enum(["up", "down"]) }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      return withTenant(db, tenantId, (tx) => reorderDocumentTemplateParameter(tx, tenantId, input.id, input.direction)).catch(
        toBadRequest,
      );
    }),

  deleteParameter: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      await withTenant(db, tenantId, (tx) => deleteDocumentTemplateParameter(tx, tenantId, input.id));
      return { ok: true };
    }),

  // --- Live preview (backlog item 9.30): "as you make changes" needs to be fast, so this
  // renders the Handlebars template only (no wkhtmltopdf - that's a real subprocess per
  // call, fine for one deliberate "Generate" click, not for every keystroke) against a
  // real example entity the operator picks. `ensureHtmlDocument` is applied here the same
  // way `renderPdf` applies it, so what's previewed matches the real PDF's default
  // styling for a template that's just a body fragment. ------------------------------

  /** Recent test cases across every product, for the test-case-scope preview picker - no
   * existing query lists across products (they're all scoped to one product + level), so
   * this is new, capped at 30 and newest-first since that's most likely to be what
   * someone's actively working on and wants to preview against. */
  listExampleTestCases: protectedProcedure.query(async ({ ctx }) => {
    const tenantId = tenantOf(ctx);
    return withTenant(db, tenantId, (tx) =>
      tx
        .select({
          id: schema.testCases.id,
          title: schema.testCases.title,
          sequenceNumber: schema.testCases.sequenceNumber,
          levelCode: schema.levels.code,
          productName: schema.products.name,
        })
        .from(schema.testCases)
        .innerJoin(schema.levels, eq(schema.testCases.levelId, schema.levels.id))
        .innerJoin(schema.products, eq(schema.testCases.productId, schema.products.id))
        .where(eq(schema.testCases.tenantId, tenantId))
        .orderBy(desc(schema.testCases.createdAt))
        .limit(30),
    );
  }),

  /** Same reasoning as listExampleTestCases, for test-execution-scope preview - recent
   * executions across every test case, newest-first. */
  listExampleExecutions: protectedProcedure.query(async ({ ctx }) => {
    const tenantId = tenantOf(ctx);
    return withTenant(db, tenantId, (tx) =>
      tx
        .select({
          id: schema.testExecutions.id,
          status: schema.testExecutions.status,
          startedAt: schema.testExecutions.startedAt,
          testCaseTitle: schema.testCases.title,
          testCaseSequenceNumber: schema.testCases.sequenceNumber,
          levelCode: schema.levels.code,
        })
        .from(schema.testExecutions)
        .innerJoin(schema.testCases, eq(schema.testExecutions.testCaseId, schema.testCases.id))
        .innerJoin(schema.levels, eq(schema.testCases.levelId, schema.levels.id))
        .where(eq(schema.testExecutions.tenantId, tenantId))
        .orderBy(desc(schema.testExecutions.startedAt))
        .limit(30),
    );
  }),

  previewHtml: protectedProcedure
    .input(
      z.object({
        templateId: z.string().uuid(),
        // The current, possibly-unsaved editor draft - not re-read from the database,
        // so the preview reflects what's on screen right now, not the last-saved copy.
        htmlTemplate: z.string(),
        // Same "current draft, not last-saved" reasoning as htmlTemplate above.
        filenameTemplate: z.string().optional(),
        testCaseId: z.string().uuid().optional(),
        executionId: z.string().uuid().optional(),
        requirementIds: z.array(z.string().uuid()).optional(),
        productId: z.string().uuid().optional(),
        levelId: z.string().uuid().optional(),
        paramValues: z.record(z.string(), z.string()).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      try {
        return await withTenant(db, tenantId, async (tx) => {
          const template = await getDocumentTemplate(tx, tenantId, input.templateId);
          const parameters = await listDocumentTemplateParameters(tx, tenantId, input.templateId);
          // Unlike the real generate route, a missing required parameter doesn't fail
          // the whole preview - it just renders empty, so a half-filled-in preview still
          // shows *something* rather than blocking on the first field typed into.
          const params: Record<string, string> = {};
          for (const p of parameters) {
            const raw = input.paramValues?.[p.key]?.trim();
            if (raw) params[p.key] = raw;
          }

          let context: Record<string, unknown> | null = null;
          if (template.scope === "test_case") {
            if (input.testCaseId) context = await buildTestCaseDocumentContext(tx, tenantId, input.testCaseId);
          } else if (template.scope === "test_execution") {
            if (input.executionId) context = await buildTestExecutionDocumentContext(tx, tenantId, input.executionId);
          } else {
            if (input.requirementIds?.length && input.productId && input.levelId) {
              const [product] = await tx.select().from(schema.products).where(eq(schema.products.id, input.productId));
              const level = await getLevel(tx, tenantId, input.levelId);
              if (product) {
                context = await buildRequirementListDocumentContext(tx, tenantId, input.requirementIds, {
                  productName: product.name,
                  levelName: level.name,
                });
              }
            }
          }
          if (!context) return { html: null, filename: null, error: null };
          context.params = params;

          const html = ensureHtmlDocument(renderTemplate(input.htmlTemplate, context));
          const filename = `${renderFilename(input.filenameTemplate, context, template.name)}.pdf`;
          return { html, filename, error: null };
        });
      } catch (err) {
        return { html: null, filename: null, error: err instanceof Error ? err.message : "preview failed" };
      }
    }),
});
