import { db } from "@/lib/db";
import { generateOneDocument } from "@/server/document-generation";
import { requireActiveUser } from "@/server/tenant-access";
import { DomainError, getDocumentTemplate, listDocumentTemplateParameters, resolveDocumentTemplateParameterValues } from "@galm/core";
import { withTenant } from "@galm/db";
import { zipFiles } from "@galm/documents";
import { NextResponse } from "next/server";

/**
 * Generates one PDF per selected test case or execution and returns them all as one zip
 * (backlog item 9.32 - "select a bunch of test cases/executions and create separate
 * reports for all of them... download in one zip"). Sibling of `/api/documents/generate`
 * (one document); see apps/web/src/server/document-generation.ts for the per-target logic
 * both share. Only `test_case`/`test_execution` scopes make sense here - a
 * `requirement_list` template already produces one combined document for a whole list in
 * a single call to the non-bulk route, so "bulk" doesn't apply to it the same way.
 *
 * Body: `{ templateId, testCaseIds: string[] }` or `{ templateId, executionIds: string[] }`
 * (exactly one, matching the template's own scope), plus optional `paramValues` - shared
 * across every generated file in the batch, not resolved per target: filling in
 * "Prepared by" once for the whole export is the realistic case, not once per file.
 *
 * **Streams progress** (backlog item 9.34 - "a progress indicator would be nice if it
 * takes a while") rather than going silent until everything's done: the response is
 * newline-delimited JSON, one `{"type":"progress","done":N,"total":M}` line per
 * completed target as it finishes, then a final line - `{"type":"done", filename,
 * zipBase64}` on success, or `{"type":"error", message}` if every target failed. The
 * zip itself travels base64-encoded *inside* that last JSON line rather than as raw
 * bytes after a text/binary boundary - a real size cost (~33% larger), accepted
 * deliberately: every line staying valid JSON avoids any binary-framing edge cases on
 * either end, and reports at this product's scale don't make that overhead meaningful.
 * The one thing this rules out: once the stream has started (HTTP 200 already sent), an
 * "every target failed" outcome can no longer become a 4xx/5xx status - it's the
 * `"error"` line instead. Validation that can be decided *before* any generation work
 * starts (bad templateId, wrong scope, too many targets, wrong id array for the scope)
 * still returns a normal non-200 JSON response, since nothing has streamed yet at that
 * point.
 *
 * Continues past a single target's failure rather than aborting the whole batch (the
 * same "don't let one bad row take down the rest" principle as every importer in this
 * codebase) - a failure is recorded into `errors.txt` inside the zip instead of silently
 * disappearing. One `withTenant` transaction *per target*, not one for the whole batch -
 * the identical reasoning `runSpiraImport` documents for why (lock contention, and
 * Postgres aborting a whole transaction after one failed statement inside it).
 */
const MAX_BULK_TARGETS = 100;

export async function POST(req: Request) {
  const user = await requireActiveUser(req);
  if (user instanceof Response) return user;
  const tenantId = user.tenantId;

  let body: {
    templateId?: string;
    testCaseIds?: string[];
    executionIds?: string[];
    paramValues?: Record<string, string>;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.templateId) {
    return NextResponse.json({ error: "templateId is required" }, { status: 400 });
  }
  const ids = body.testCaseIds ?? body.executionIds ?? [];
  if (ids.length === 0) {
    return NextResponse.json({ error: "testCaseIds or executionIds is required" }, { status: 400 });
  }
  if (ids.length > MAX_BULK_TARGETS) {
    return NextResponse.json({ error: `too many selected at once (${ids.length}) - the limit is ${MAX_BULK_TARGETS}` }, { status: 400 });
  }

  // Everything decidable before generation starts - still a normal error response,
  // since nothing has streamed yet.
  let template: Awaited<ReturnType<typeof getDocumentTemplate>>;
  let params: Record<string, string>;
  try {
    const validated = await withTenant(db, tenantId, async (tx) => {
      const t = await getDocumentTemplate(tx, tenantId, body.templateId!);
      if (t.scope !== "test_case" && t.scope !== "test_execution") {
        throw new DomainError("bulk generation only applies to test case and test execution templates");
      }
      if (t.scope === "test_case" && !body.testCaseIds?.length) {
        throw new DomainError("this is a test case template - pass testCaseIds, not executionIds");
      }
      if (t.scope === "test_execution" && !body.executionIds?.length) {
        throw new DomainError("this is a test execution template - pass executionIds, not testCaseIds");
      }
      const parameters = await listDocumentTemplateParameters(tx, tenantId, t.id);
      const p = resolveDocumentTemplateParameterValues(
        parameters.map((param) => ({ key: param.key, label: param.label, type: param.type as "text" | "date", isRequired: param.isRequired })),
        body.paramValues ?? {},
      );
      return { template: t, params: p };
    });
    template = validated.template;
    params = validated.params;
  } catch (err) {
    const message = err instanceof Error ? err.message : "bulk document generation failed";
    const status = err instanceof DomainError ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const files: Array<{ filename: string; content: Uint8Array }> = [];
      const errors: string[] = [];
      let done = 0;
      for (const id of ids) {
        try {
          const target = template.scope === "test_case" ? { testCaseId: id } : { executionId: id };
          const { bytes, filename } = await withTenant(db, tenantId, (tx) => generateOneDocument(tx, tenantId, template, target, params));
          files.push({ filename, content: bytes });
        } catch (err) {
          errors.push(`${id}: ${err instanceof Error ? err.message : "generation failed"}`);
        }
        done++;
        controller.enqueue(encoder.encode(`${JSON.stringify({ type: "progress", done, total: ids.length })}\n`));
      }

      if (files.length === 0) {
        controller.enqueue(
          encoder.encode(
            `${JSON.stringify({ type: "error", message: `every selected item failed to generate:\n${errors.join("\n")}` })}\n`,
          ),
        );
        controller.close();
        return;
      }
      if (errors.length > 0) {
        files.push({ filename: "errors.txt", content: encoder.encode(errors.join("\n")) });
      }
      const zipBytes = await zipFiles(files);
      controller.enqueue(
        encoder.encode(
          `${JSON.stringify({ type: "done", filename: "documents.zip", zipBase64: Buffer.from(zipBytes).toString("base64") })}\n`,
        ),
      );
      controller.close();
    },
  });

  return new Response(stream, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
}
