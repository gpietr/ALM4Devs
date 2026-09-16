import {
  buildRequirementListDocumentContext,
  buildTestCaseDocumentContext,
  buildTestExecutionDocumentContext,
  DomainError,
  getLevel,
  type DocumentTemplateScope,
} from "@galm/core";
import { schema, type TenantTx } from "@galm/db";
import { renderFilename, renderPdf, renderTemplate } from "@galm/documents";
import { eq } from "drizzle-orm";

/**
 * Shared by both generation routes (`/api/documents/generate` for one document,
 * `/api/documents/generate-bulk` for many at once, zipped - backlog items 9.29/9.32) -
 * the per-target work (build context for the template's scope, render, convert to PDF,
 * name the file) is identical either way; only how many times it runs, and what wraps
 * the result, differs. Kept here rather than duplicated in each route so the two can't
 * quietly drift apart on what a given scope actually needs.
 */

export interface GenerateTarget {
  testCaseId?: string;
  executionId?: string;
  requirementIds?: string[];
  productId?: string;
  levelId?: string;
}

async function buildContext(
  tx: TenantTx,
  tenantId: string,
  scope: DocumentTemplateScope,
  target: GenerateTarget,
): Promise<Record<string, unknown>> {
  if (scope === "test_case") {
    if (!target.testCaseId) throw new DomainError("testCaseId is required for a test case template");
    return buildTestCaseDocumentContext(tx, tenantId, target.testCaseId);
  }
  if (scope === "test_execution") {
    if (!target.executionId) throw new DomainError("executionId is required for a test execution template");
    return buildTestExecutionDocumentContext(tx, tenantId, target.executionId);
  }
  if (!target.requirementIds?.length) throw new DomainError("requirementIds is required for a requirement list template");
  if (!target.productId || !target.levelId) throw new DomainError("productId and levelId are required for a requirement list template");
  const [product] = await tx.select().from(schema.products).where(eq(schema.products.id, target.productId));
  if (!product) throw new DomainError("product not found");
  const level = await getLevel(tx, tenantId, target.levelId);
  return buildRequirementListDocumentContext(tx, tenantId, target.requirementIds, {
    productName: product.name,
    levelName: level.name,
  });
}

/** Renders one target through one template into PDF bytes plus a filename
 * (`renderFilename` against the same context the body rendered against, falling back to
 * the template's own `name`). `params` is shared across every target in a batch, not
 * resolved per-target - see the bulk route's docstring for why that's the right default
 * for "fill in Prepared-by once for the whole export", not per file. */
export async function generateOneDocument(
  tx: TenantTx,
  tenantId: string,
  template: { scope: string; htmlTemplate: string; filenameTemplate: string | null; name: string },
  target: GenerateTarget,
  params: Record<string, string>,
): Promise<{ bytes: Uint8Array; filename: string }> {
  const context = await buildContext(tx, tenantId, template.scope as DocumentTemplateScope, target);
  context.params = params;
  const renderedHtml = renderTemplate(template.htmlTemplate, context);
  const bytes = await renderPdf(renderedHtml);
  const filename = `${renderFilename(template.filenameTemplate, context, template.name)}.pdf`;
  return { bytes, filename };
}
