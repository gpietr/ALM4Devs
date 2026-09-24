import { db } from "@/lib/db";
import {
  getSpiraConnection,
  sanitizeRichText,
  saveSpiraConnection,
} from "@galm/core";
import { withTenant } from "@galm/db";
import {
  previewSpiraImport,
  previewSpiraTestCaseImport,
  runSpiraImport,
  runSpiraTestCaseImport,
  SPIRA_IMPORT_MAX_ROWS_DEFAULT,
  SpiraClient,
} from "@galm/integrations-spira";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { orgAdminProcedure, protectedProcedure, router } from "../trpc";

function tenantOf(ctx: { session: { user: unknown } }): string {
  return (ctx.session.user as { tenantId: string }).tenantId;
}
function userIdOf(ctx: { session: { user: unknown } }): string {
  return (ctx.session.user as { id: string }).id;
}

function toBadRequest(err: unknown): never {
  throw new TRPCError({ code: "BAD_REQUEST", message: err instanceof Error ? err.message : "request failed" });
}

async function requireClient(tenantId: string): Promise<SpiraClient> {
  const connection = await withTenant(db, tenantId, (tx) => getSpiraConnection(tx, tenantId));
  if (!connection) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "no Spira connection saved yet - save one first" });
  }
  return new SpiraClient({
    baseUrl: connection.baseUrl,
    username: connection.username,
    apiKey: connection.apiKey,
    projectId: connection.projectId,
  });
}

const mappingSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  background: z.string().optional(),
  legacyId: z.string().optional(),
  // Our custom field id -> the Spira field key to read for it - see
  // RequirementFieldMapping.customFields (packages/integrations/spira/src/import.ts).
  customFields: z.record(z.string().uuid(), z.string()).optional(),
});

const testCaseMappingSchema = z.object({
  title: z.string().min(1),
  purpose: z.string().optional(),
  legacyId: z.string().optional(),
  customFields: z.record(z.string().uuid(), z.string()).optional(),
});

/**
 * Rich text arriving from Spira has been through no sanitizer at all: it's whatever the
 * remote instance's API returned. The import's *write* path sanitizes (createRequirement /
 * createTestCase in @galm/core), but these preview procedures hand rows straight to the
 * browser, where the import pages render them with RichTextView - i.e.
 * dangerouslySetInnerHTML. Without this, a Spira instance serving
 * `<img src=x onerror=...>` executes it in the previewing user's session.
 *
 * Applied here rather than deeper in @galm/integrations-spira on purpose: that package is
 * a transport, and deliberately doesn't depend on @galm/core. This router is the boundary
 * where remote data becomes something we hand to our own UI, so it's where the data stops
 * being untrusted.
 */
function sanitizeMaybe<T extends string | null | undefined>(html: T): T {
  return (typeof html === "string" ? sanitizeRichText(html) : html) as T;
}

export const spiraImportRouter = router({
  getConnection: protectedProcedure.query(async ({ ctx }) => {
    const tenantId = tenantOf(ctx);
    const connection = await withTenant(db, tenantId, (tx) => getSpiraConnection(tx, tenantId));
    if (!connection) return null;
    // Never echo the API key back to the client, even after saving it.
    return {
      baseUrl: connection.baseUrl,
      apiVersion: connection.apiVersion,
      username: connection.username,
      projectId: connection.projectId,
      hasApiKey: true,
    };
  }),

  saveConnection: orgAdminProcedure
    .input(
      z.object({
        baseUrl: z.string().trim().url(),
        apiVersion: z.string().trim().min(1).max(20),
        username: z.string().trim().min(1).max(200),
        apiKey: z.string().trim().max(500).optional(),
        projectId: z.number().int().positive(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      await withTenant(db, tenantId, (tx) => saveSpiraConnection(tx, tenantId, input)).catch(toBadRequest);
      return { ok: true };
    }),

  testConnection: orgAdminProcedure.mutation(async ({ ctx }) => {
    const tenantId = tenantOf(ctx);
    const client = await requireClient(tenantId);
    try {
      return await client.testConnection();
    } catch (err) {
      throw new TRPCError({ code: "BAD_REQUEST", message: err instanceof Error ? err.message : "connection failed" });
    }
  }),

  listFields: protectedProcedure.query(async ({ ctx }) => {
    const tenantId = tenantOf(ctx);
    const client = await requireClient(tenantId);
    try {
      return await client.listRequirementFields();
    } catch (err) {
      throw new TRPCError({ code: "BAD_REQUEST", message: err instanceof Error ? err.message : "failed to list fields" });
    }
  }),

  listTestCaseFields: protectedProcedure.query(async ({ ctx }) => {
    const tenantId = tenantOf(ctx);
    const client = await requireClient(tenantId);
    try {
      return await client.listTestCaseFields();
    } catch (err) {
      throw new TRPCError({ code: "BAD_REQUEST", message: err instanceof Error ? err.message : "failed to list fields" });
    }
  }),

  listTestStepFields: protectedProcedure.query(async ({ ctx }) => {
    const tenantId = tenantOf(ctx);
    const client = await requireClient(tenantId);
    try {
      return await client.listTestStepFields();
    } catch (err) {
      throw new TRPCError({ code: "BAD_REQUEST", message: err instanceof Error ? err.message : "failed to list fields" });
    }
  }),

  preview: protectedProcedure
    .input(z.object({ mapping: mappingSchema, limit: z.number().int().min(1).max(50).default(10) }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      const client = await requireClient(tenantId);
      try {
        const rows = await previewSpiraImport(client, input.mapping, input.limit);
        return rows.map((row) => ({ ...row, background: sanitizeMaybe(row.background) }));
      } catch (err) {
        throw new TRPCError({ code: "BAD_REQUEST", message: err instanceof Error ? err.message : "preview failed" });
      }
    }),

  run: protectedProcedure
    .input(
      z.object({
        productId: z.string().uuid(),
        levelId: z.string().uuid(),
        mapping: mappingSchema,
        // Optional resume point for a run that was interrupted partway - not a page-size
        // limit. runSpiraImport pages through the whole project on its own.
        startRow: z.number().int().min(1).default(1),
        // Caps how many rows this one call processes - the import screen calls this
        // mutation repeatedly with an advancing startRow, using a small maxRows each time,
        // to show "x/n processed" progress instead of one long silent request (backlog
        // item 9.26). Left unset (whole run in one call) still works for any other caller.
        maxRows: z.number().int().min(1).max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      const userId = userIdOf(ctx);
      const client = await requireClient(tenantId);
      try {
        // Not wrapped in withTenant here - runSpiraImport opens its own per-row
        // transaction against the raw pool (see its docstring for why: a single
        // transaction spanning the whole run held the sequence counter and the audit-log
        // advisory lock for the run's entire duration, and broke the per-row error
        // isolation the try/catch below is supposed to provide).
        return await runSpiraImport(db, client, {
          tenantId,
          productId: input.productId,
          levelId: input.levelId,
          createdBy: userId,
          mapping: input.mapping,
          startRow: input.startRow,
          maxRows: input.maxRows,
        });
      } catch (err) {
        throw new TRPCError({ code: "BAD_REQUEST", message: err instanceof Error ? err.message : "import failed" });
      }
    }),

  /** Total requirement count this project has, capped the same way a real run is - lets
   * the import screen show an honest "x/n" denominator before starting (backlog item
   * 9.26). A query, not a mutation: read-only, safe to call speculatively. */
  countRequirements: protectedProcedure.query(async ({ ctx }) => {
    const tenantId = tenantOf(ctx);
    const client = await requireClient(tenantId);
    try {
      return { count: await client.countRequirements(SPIRA_IMPORT_MAX_ROWS_DEFAULT) };
    } catch (err) {
      throw new TRPCError({ code: "BAD_REQUEST", message: err instanceof Error ? err.message : "count failed" });
    }
  }),

  previewTestCases: protectedProcedure
    .input(
      z.object({
        mapping: testCaseMappingSchema,
        limit: z.number().int().min(1).max(50).default(5),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      const client = await requireClient(tenantId);
      try {
        const rows = await previewSpiraTestCaseImport(client, input.mapping, input.limit);
        return rows.map((row) => ({
          ...row,
          steps: row.steps.map((step) => ({
            ...step,
            description: sanitizeMaybe(step.description),
            expectedResult: sanitizeMaybe(step.expectedResult),
            purpose: sanitizeMaybe(step.purpose),
          })),
        }));
      } catch (err) {
        throw new TRPCError({ code: "BAD_REQUEST", message: err instanceof Error ? err.message : "preview failed" });
      }
    }),

  runTestCases: protectedProcedure
    .input(
      z.object({
        productId: z.string().uuid(),
        levelId: z.string().uuid(),
        mapping: testCaseMappingSchema,
        // Optional resume point for a run that was interrupted partway - not a page-size
        // limit. runSpiraTestCaseImport pages through the whole project on its own.
        startRow: z.number().int().min(1).default(1),
        // See `run`'s identical field above - chunked progress (backlog item 9.26).
        maxRows: z.number().int().min(1).max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      const userId = userIdOf(ctx);
      const client = await requireClient(tenantId);
      try {
        // See the comment on `run` above - same per-row-transaction reasoning.
        return await runSpiraTestCaseImport(db, client, {
          tenantId,
          productId: input.productId,
          levelId: input.levelId,
          createdBy: userId,
          mapping: input.mapping,
          startRow: input.startRow,
          maxRows: input.maxRows,
        });
      } catch (err) {
        throw new TRPCError({ code: "BAD_REQUEST", message: err instanceof Error ? err.message : "import failed" });
      }
    }),

  /** See `countRequirements` above - same "honest x/n denominator" reasoning, for the
   * test case import screen. */
  countTestCases: protectedProcedure.query(async ({ ctx }) => {
    const tenantId = tenantOf(ctx);
    const client = await requireClient(tenantId);
    try {
      return { count: await client.countTestCases(SPIRA_IMPORT_MAX_ROWS_DEFAULT) };
    } catch (err) {
      throw new TRPCError({ code: "BAD_REQUEST", message: err instanceof Error ? err.message : "count failed" });
    }
  }),
});
