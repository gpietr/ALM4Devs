import { db } from "@/lib/db";
import { generateOneDocument, type GenerateTarget } from "@/server/document-generation";
import { requireActiveUser } from "@/server/tenant-access";
import { DomainError, getDocumentTemplate, listDocumentTemplateParameters, resolveDocumentTemplateParameterValues } from "@galm/core";
import { withTenant } from "@galm/db";
import { NextResponse } from "next/server";

/**
 * Generates a PDF from a tenant's own document template (backlog item 9.29) - a raw
 * route, not a tRPC procedure, since the response is a binary PDF, not JSON (same
 * reasoning as /api/attachments/*). Nothing about the result is ever stored: the PDF
 * exists only in this response, generated on demand and streamed straight back for the
 * browser to download - see @galm/documents' docstring. `/api/documents/generate-bulk`
 * is this route's sibling for many targets at once, zipped - see
 * apps/web/src/server/document-generation.ts for the per-target logic both share.
 *
 * Body shape depends on the template's own `scope`:
 * - test_case:        { templateId, testCaseId, paramValues? }
 * - test_execution:   { templateId, executionId, paramValues? }
 * - requirement_list: { templateId, requirementIds: string[], productId, levelId, paramValues? }
 */
export async function POST(req: Request) {
  const user = await requireActiveUser(req);
  if (user instanceof Response) return user;
  const tenantId = user.tenantId;

  let body: GenerateTarget & { templateId?: string; paramValues?: Record<string, string> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.templateId) {
    return NextResponse.json({ error: "templateId is required" }, { status: 400 });
  }

  try {
    const result = await withTenant(db, tenantId, async (tx) => {
      const template = await getDocumentTemplate(tx, tenantId, body.templateId!);
      const parameters = await listDocumentTemplateParameters(tx, tenantId, template.id);
      const params = resolveDocumentTemplateParameterValues(
        parameters.map((p) => ({ key: p.key, label: p.label, type: p.type as "text" | "date", isRequired: p.isRequired })),
        body.paramValues ?? {},
      );
      return generateOneDocument(tx, tenantId, template, body, params);
    });

    // `Buffer.from(...)`, not the raw `Uint8Array` - this TS/lib.dom.d.ts combination
    // doesn't accept a bare `Uint8Array<ArrayBufferLike>` as `BodyInit` (a known
    // ecosystem friction point since Uint8Array became generic over its buffer type);
    // `Buffer` (a Node/Bun global, and a `Uint8Array` subclass at runtime - no copy of
    // consequence) is unambiguously typed as valid `BodyInit`.
    return new Response(Buffer.from(result.bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${result.filename}"`,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "document generation failed";
    const status = err instanceof DomainError ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
