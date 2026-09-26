import { db } from "@/lib/db";
import {
  createOtsAnomaly,
  deleteOtsAnomaly,
  getOtsDocumentation,
  getOtsRegister,
  getOtsReleaseChanges,
  importOtsAnomalies,
  listOtsAnomalyExternalIds,
  markOtsAnomaliesReviewed,
  OTS_ANOMALY_OUTCOMES,
  OTS_CATEGORIES,
  OTS_PROFILE_TEXT_FIELDS,
  OTS_VERSION_SUPPORT_STATUSES,
  type OtsProfileTextField,
  replaceOtsPlatformLinks,
  setArchitectureNodeVersionSupportStatus,
  updateOtsAnomaly,
  upsertOtsProfile,
  upsertOtsVersionAssessment,
} from "@galm/core";
import { withTenant } from "@galm/db";
import { GithubApiError, githubIssueExternalId, parseGithubIssuesUrl } from "@galm/integrations-github";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "../trpc";
import { buildGithubClient } from "./github";

function tenantOf(ctx: { session: { user: unknown } }): string {
  return (ctx.session.user as { tenantId: string }).tenantId;
}
function userIdOf(ctx: { session: { user: unknown } }): string {
  return (ctx.session.user as { id: string }).id;
}

function toBadRequest(err: unknown): never {
  throw new TRPCError({ code: "BAD_REQUEST", message: err instanceof Error ? err.message : "request failed" });
}

const longText = z.string().max(20000).nullable().optional();

// Generated from packages/core's field list so new fields need no second edit.
const profileTextShape = Object.fromEntries(OTS_PROFILE_TEXT_FIELDS.map((f) => [f.key, longText])) as Record<
  OtsProfileTextField,
  typeof longText
>;

const profileSchema = z.object({
  ...profileTextShape,
  category: z.enum(OTS_CATEGORIES).nullable().optional(),
  // "YYYY-MM-DD", or null to clear.
  endOfSupportDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

const anomalySchema = z.object({
  externalId: z.string().trim().max(300).nullable().optional(),
  title: z.string().trim().min(1).max(500),
  description: z.string().max(20000).optional(),
  sourceUrl: z.string().trim().max(2000).nullable().optional(),
  discoveryMethod: longText,
  rootCause: longText,
  impactEvaluation: longText,
  outcome: z.enum(OTS_ANOMALY_OUTCOMES).nullable().optional(),
  rationale: longText,
  defectClassification: z.string().trim().max(300).nullable().optional(),
  mitigation: longText,
  endUserCommunication: longText,
  resolvedInVersion: z.string().trim().max(200).nullable().optional(),
  affectedVersionIds: z.array(z.string().uuid()).optional(),
  requirementIds: z.array(z.string().uuid()).optional(),
});

const GITHUB_PREVIEW_LIMIT = 200;

function parseIssuesUrlOrThrow(url: string) {
  const parsed = parseGithubIssuesUrl(url);
  if (!parsed) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "not a GitHub issues URL (expected github.com/owner/repo/issues…)" });
  }
  return parsed;
}

/** OTS documentation (packages/core/src/ots.ts). Identity - title, supplier, recording
 * versions - stays on the architecture/vulnerabilities routers. */
export const otsRouter = router({
  documentation: protectedProcedure.input(z.object({ nodeId: z.string().uuid() })).query(async ({ ctx, input }) => {
    const tenantId = tenantOf(ctx);
    return withTenant(db, tenantId, (tx) => getOtsDocumentation(tx, tenantId, input.nodeId)).catch((err) => {
      throw new TRPCError({ code: "NOT_FOUND", message: err instanceof Error ? err.message : undefined });
    });
  }),

  updateProfile: protectedProcedure
    .input(z.object({ nodeId: z.string().uuid(), fields: profileSchema }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      const userId = userIdOf(ctx);
      const { endOfSupportDate, ...rest } = input.fields;
      return withTenant(db, tenantId, (tx) =>
        upsertOtsProfile(tx, {
          tenantId,
          architectureNodeId: input.nodeId,
          actorUserId: userId,
          fields: {
            ...rest,
            ...(endOfSupportDate !== undefined
              ? { endOfSupportDate: endOfSupportDate ? new Date(endOfSupportDate) : null }
              : {}),
          },
        }),
      ).catch(toBadRequest);
    }),

  setPlatformLinks: protectedProcedure
    .input(z.object({ nodeId: z.string().uuid(), platformNodeIds: z.array(z.string().uuid()) }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      const userId = userIdOf(ctx);
      await withTenant(db, tenantId, (tx) =>
        replaceOtsPlatformLinks(tx, {
          tenantId,
          architectureNodeId: input.nodeId,
          platformNodeIds: input.platformNodeIds,
          actorUserId: userId,
        }),
      ).catch(toBadRequest);
      return { ok: true };
    }),

  setVersionStatus: protectedProcedure
    .input(
      z.object({
        nodeId: z.string().uuid(),
        versionId: z.string().uuid(),
        supportStatus: z.enum(OTS_VERSION_SUPPORT_STATUSES),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      const userId = userIdOf(ctx);
      await withTenant(db, tenantId, (tx) =>
        setArchitectureNodeVersionSupportStatus(tx, {
          tenantId,
          architectureNodeId: input.nodeId,
          versionId: input.versionId,
          supportStatus: input.supportStatus,
          actorUserId: userId,
        }),
      ).catch(toBadRequest);
      return { ok: true };
    }),

  saveVersionAssessment: protectedProcedure
    .input(
      z.object({
        nodeId: z.string().uuid(),
        versionId: z.string().uuid(),
        fields: z.object({
          safetyImpact: longText,
          designImpact: longText,
          installationImpact: longText,
          obsolescenceImpact: longText,
          regressionAnalysis: longText,
          verificationSummary: longText,
          regressionTestPerformed: z.boolean().optional(),
          testSetId: z.string().uuid().nullable().optional(),
        }),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      const userId = userIdOf(ctx);
      await withTenant(db, tenantId, (tx) =>
        upsertOtsVersionAssessment(tx, {
          tenantId,
          architectureNodeId: input.nodeId,
          versionId: input.versionId,
          fields: input.fields,
          actorUserId: userId,
        }),
      ).catch(toBadRequest);
      return { ok: true };
    }),

  createAnomaly: protectedProcedure
    .input(z.object({ nodeId: z.string().uuid(), anomaly: anomalySchema }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      const userId = userIdOf(ctx);
      return withTenant(db, tenantId, (tx) =>
        createOtsAnomaly(tx, { tenantId, architectureNodeId: input.nodeId, input: input.anomaly, actorUserId: userId }),
      ).catch(toBadRequest);
    }),

  updateAnomaly: protectedProcedure
    .input(z.object({ anomalyId: z.string().uuid(), anomaly: anomalySchema }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      const userId = userIdOf(ctx);
      await withTenant(db, tenantId, (tx) =>
        updateOtsAnomaly(tx, { tenantId, anomalyId: input.anomalyId, input: input.anomaly, actorUserId: userId }),
      ).catch(toBadRequest);
      return { ok: true };
    }),

  deleteAnomaly: protectedProcedure.input(z.object({ anomalyId: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    const tenantId = tenantOf(ctx);
    const userId = userIdOf(ctx);
    await withTenant(db, tenantId, (tx) => deleteOtsAnomaly(tx, { tenantId, anomalyId: input.anomalyId, actorUserId: userId })).catch(
      toBadRequest,
    );
    return { ok: true };
  }),

  markAnomaliesReviewed: protectedProcedure.input(z.object({ nodeId: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    const tenantId = tenantOf(ctx);
    const userId = userIdOf(ctx);
    await withTenant(db, tenantId, (tx) =>
      markOtsAnomaliesReviewed(tx, { tenantId, architectureNodeId: input.nodeId, actorUserId: userId }),
    ).catch(toBadRequest);
    return { ok: true };
  }),

  /** Fetches the issues a GitHub issues URL lists, marking ones this item already has. */
  previewGithubIssues: protectedProcedure
    .input(z.object({ nodeId: z.string().uuid(), url: z.string().trim().min(1).max(2000) }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      const parsed = parseIssuesUrlOrThrow(input.url);
      const client = await buildGithubClient(tenantId);
      const result = await client.searchIssues(parsed, { limit: GITHUB_PREVIEW_LIMIT }).catch((err) => {
        throw new TRPCError({ code: "BAD_REQUEST", message: err instanceof GithubApiError ? err.message : "GitHub request failed" });
      });
      const existing = await withTenant(db, tenantId, (tx) => listOtsAnomalyExternalIds(tx, tenantId, input.nodeId));
      return {
        query: parsed.query,
        totalCount: result.totalCount,
        truncated: result.truncated,
        issues: result.items.map((issue) => {
          const externalId = githubIssueExternalId(parsed, issue.number);
          return { ...issue, externalId, alreadyImported: existing.has(externalId) };
        }),
      };
    }),

  /** Imports previewed issues; ones already present are skipped. */
  importGithubIssues: protectedProcedure
    .input(
      z.object({
        nodeId: z.string().uuid(),
        url: z.string().trim().min(1).max(2000),
        issues: z
          .array(
            z.object({
              number: z.number().int().positive(),
              title: z.string().trim().min(1).max(500),
              body: z.string(),
              htmlUrl: z.string().url().max(2000),
              state: z.enum(["open", "closed"]),
              milestone: z.string().max(200).nullable(),
            }),
          )
          .min(1)
          .max(GITHUB_PREVIEW_LIMIT),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenantOf(ctx);
      const userId = userIdOf(ctx);
      const parsed = parseIssuesUrlOrThrow(input.url);
      const repo = `${parsed.owner}/${parsed.repo}`;
      const repoPrefix = `https://github.com/${repo}/issues/`.toLowerCase();
      if (input.issues.some((i) => !i.htmlUrl.toLowerCase().startsWith(repoPrefix))) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `issues must belong to ${repo}` });
      }
      return withTenant(db, tenantId, (tx) =>
        importOtsAnomalies(tx, {
          tenantId,
          architectureNodeId: input.nodeId,
          source: input.url,
          actorUserId: userId,
          items: input.issues.map((issue) => ({
            externalId: githubIssueExternalId(parsed, issue.number),
            title: issue.title,
            description: issue.body.slice(0, 20000),
            sourceUrl: issue.htmlUrl,
            discoveryMethod: "Vendor issue tracker (GitHub)",
            resolvedInVersion: issue.state === "closed" ? issue.milestone : null,
          })),
        }),
      ).catch(toBadRequest);
    }),

  /** Product-wide OTS register - every OTS item across all architecture levels. */
  register: protectedProcedure.input(z.object({ productId: z.string().uuid() })).query(async ({ ctx, input }) => {
    const tenantId = tenantOf(ctx);
    return withTenant(db, tenantId, (tx) => getOtsRegister(tx, tenantId, input.productId)).catch(toBadRequest);
  }),

  /** OTS changes release to release. */
  releaseChanges: protectedProcedure.input(z.object({ productId: z.string().uuid() })).query(async ({ ctx, input }) => {
    const tenantId = tenantOf(ctx);
    return withTenant(db, tenantId, (tx) => getOtsReleaseChanges(tx, tenantId, input.productId)).catch(toBadRequest);
  }),
});
