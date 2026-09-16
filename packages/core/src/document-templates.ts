import { type TenantTx, schema } from "@galm/db";
import { and, asc, eq } from "drizzle-orm";
import { DomainError } from "./errors";
import { isUniqueViolation } from "./level-sequences";

/**
 * Tenant-defined PDF document templates (backlog item 9.29) - HTML+CSS with Handlebars
 * placeholders, rendered against real entity data and converted to PDF by
 * `@galm/documents`. This module owns only the template/parameter CRUD (the same
 * definition-management shape as custom-fields.ts's field/option CRUD); building the
 * per-scope data context a template actually renders against lives in
 * document-context.ts, and rendering/PDF conversion in `@galm/documents` - kept separate
 * since neither of those needs a database connection the way this does.
 */

export type DocumentTemplateScope = "test_case" | "test_execution" | "requirement_list";
export const DOCUMENT_TEMPLATE_SCOPES: ReadonlyArray<{ value: DocumentTemplateScope; label: string }> = [
  { value: "test_case", label: "Test case" },
  { value: "test_execution", label: "Test execution" },
  { value: "requirement_list", label: "Requirement list" },
];

export type DocumentTemplateParameterType = "text" | "date";
export const DOCUMENT_TEMPLATE_PARAMETER_TYPES: ReadonlyArray<{ value: DocumentTemplateParameterType; label: string }> = [
  { value: "text", label: "Text" },
  { value: "date", label: "Date" },
];

// --- Templates -------------------------------------------------------------------------

export async function listDocumentTemplates(db: TenantTx, tenantId: string, scope: DocumentTemplateScope) {
  return db
    .select()
    .from(schema.documentTemplates)
    .where(and(eq(schema.documentTemplates.tenantId, tenantId), eq(schema.documentTemplates.scope, scope)))
    .orderBy(asc(schema.documentTemplates.name));
}

export async function getDocumentTemplate(db: TenantTx, tenantId: string, templateId: string) {
  const [template] = await db
    .select()
    .from(schema.documentTemplates)
    .where(and(eq(schema.documentTemplates.id, templateId), eq(schema.documentTemplates.tenantId, tenantId)));
  if (!template) throw new DomainError(`document template ${templateId} not found`);
  return template;
}

export async function createDocumentTemplate(
  db: TenantTx,
  tenantId: string,
  params: { scope: DocumentTemplateScope; name: string; htmlTemplate: string; filenameTemplate?: string },
) {
  const name = params.name.trim();
  if (!name) throw new DomainError("name must not be empty");
  const [template] = await db
    .insert(schema.documentTemplates)
    .values({
      tenantId,
      scope: params.scope,
      name,
      htmlTemplate: params.htmlTemplate,
      filenameTemplate: params.filenameTemplate?.trim() || null,
    })
    .returning()
    .catch((err) => {
      if (isUniqueViolation(err)) throw new DomainError(`a template named "${name}" already exists for this document type`);
      throw err;
    });
  if (!template) throw new DomainError("failed to create document template");
  return template;
}

export async function renameDocumentTemplate(db: TenantTx, tenantId: string, templateId: string, name: string) {
  const trimmed = name.trim();
  if (!trimmed) throw new DomainError("name must not be empty");
  await getDocumentTemplate(db, tenantId, templateId);
  const [updated] = await db
    .update(schema.documentTemplates)
    .set({ name: trimmed, updatedAt: new Date() })
    .where(and(eq(schema.documentTemplates.id, templateId), eq(schema.documentTemplates.tenantId, tenantId)))
    .returning()
    .catch((err) => {
      if (isUniqueViolation(err)) throw new DomainError(`a template named "${trimmed}" already exists for this document type`);
      throw err;
    });
  if (!updated) throw new DomainError("rename failed");
  return updated;
}

export async function updateDocumentTemplateHtml(db: TenantTx, tenantId: string, templateId: string, htmlTemplate: string) {
  await getDocumentTemplate(db, tenantId, templateId);
  const [updated] = await db
    .update(schema.documentTemplates)
    .set({ htmlTemplate, updatedAt: new Date() })
    .where(and(eq(schema.documentTemplates.id, templateId), eq(schema.documentTemplates.tenantId, tenantId)))
    .returning();
  if (!updated) throw new DomainError("update failed");
  return updated;
}

/** `filenameTemplate` (backlog item 9.31) is a separate mutation from the HTML body, same
 * "one field, one action" split as every other pair in this codebase (a level's
 * rename/code, a status's rename/enable). Empty clears it back to null - the generate
 * routes then fall back to the template's own `name`, same as a template that predates
 * this feature entirely. */
export async function updateDocumentTemplateFilename(
  db: TenantTx,
  tenantId: string,
  templateId: string,
  filenameTemplate: string,
) {
  await getDocumentTemplate(db, tenantId, templateId);
  const [updated] = await db
    .update(schema.documentTemplates)
    .set({ filenameTemplate: filenameTemplate.trim() || null, updatedAt: new Date() })
    .where(and(eq(schema.documentTemplates.id, templateId), eq(schema.documentTemplates.tenantId, tenantId)))
    .returning();
  if (!updated) throw new DomainError("update failed");
  return updated;
}

/** Cascades away every parameter defined for it (`document_template_parameters.template_id`
 * is `ON DELETE CASCADE`) - no "in use" guard the way deleting a level or custom field
 * option has, since nothing else references a template by id (a generated PDF is never
 * stored - see @galm/documents' docstring - so there's nothing downstream to leave
 * dangling). */
export async function deleteDocumentTemplate(db: TenantTx, tenantId: string, templateId: string) {
  await getDocumentTemplate(db, tenantId, templateId);
  await db
    .delete(schema.documentTemplates)
    .where(and(eq(schema.documentTemplates.id, templateId), eq(schema.documentTemplates.tenantId, tenantId)));
}

// --- Parameters --------------------------------------------------------------------

/** What the CHECK constraint on `document_template_parameters.key` already enforces at
 * the database level (migrations-manual/011) - validated here too so a bad key is
 * rejected with a clear message instead of a raw constraint-violation error. A plain
 * identifier: what a template author can type directly as `{{params.<key>}}` with no
 * quoting or escaping. */
function validateParameterKey(key: string): string {
  const trimmed = key.trim();
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(trimmed)) {
    throw new DomainError(
      `"${key}" isn't a valid parameter key - must start with a letter and contain only letters, digits, or underscores (this is what you'll type as {{params.${trimmed || "..."}}}  in the template)`,
    );
  }
  return trimmed;
}

export async function listDocumentTemplateParameters(db: TenantTx, tenantId: string, templateId: string) {
  return db
    .select()
    .from(schema.documentTemplateParameters)
    .where(
      and(
        eq(schema.documentTemplateParameters.tenantId, tenantId),
        eq(schema.documentTemplateParameters.templateId, templateId),
      ),
    )
    .orderBy(asc(schema.documentTemplateParameters.sortOrder));
}

export async function createDocumentTemplateParameter(
  db: TenantTx,
  tenantId: string,
  templateId: string,
  params: { key: string; label: string; type: DocumentTemplateParameterType; isRequired?: boolean },
) {
  await getDocumentTemplate(db, tenantId, templateId);
  const key = validateParameterKey(params.key);
  const label = params.label.trim();
  if (!label) throw new DomainError("label must not be empty");

  const existing = await listDocumentTemplateParameters(db, tenantId, templateId);
  const nextSortOrder = existing.length > 0 ? Math.max(...existing.map((p) => p.sortOrder)) + 1 : 0;
  const [param] = await db
    .insert(schema.documentTemplateParameters)
    .values({ tenantId, templateId, key, label, type: params.type, isRequired: params.isRequired ?? false, sortOrder: nextSortOrder })
    .returning()
    .catch((err) => {
      if (isUniqueViolation(err)) throw new DomainError(`a parameter with key "${key}" already exists on this template`);
      throw err;
    });
  if (!param) throw new DomainError("failed to create parameter");
  return param;
}

export async function updateDocumentTemplateParameter(
  db: TenantTx,
  tenantId: string,
  parameterId: string,
  params: { label?: string; type?: DocumentTemplateParameterType; isRequired?: boolean },
) {
  const set: { label?: string; type?: DocumentTemplateParameterType; isRequired?: boolean } = {};
  if (params.label !== undefined) {
    const trimmed = params.label.trim();
    if (!trimmed) throw new DomainError("label must not be empty");
    set.label = trimmed;
  }
  if (params.type !== undefined) set.type = params.type;
  if (params.isRequired !== undefined) set.isRequired = params.isRequired;

  const [updated] = await db
    .update(schema.documentTemplateParameters)
    .set(set)
    .where(and(eq(schema.documentTemplateParameters.id, parameterId), eq(schema.documentTemplateParameters.tenantId, tenantId)))
    .returning();
  if (!updated) throw new DomainError("parameter not found");
  return updated;
}

export async function reorderDocumentTemplateParameter(
  db: TenantTx,
  tenantId: string,
  parameterId: string,
  direction: "up" | "down",
) {
  const [param] = await db
    .select()
    .from(schema.documentTemplateParameters)
    .where(and(eq(schema.documentTemplateParameters.id, parameterId), eq(schema.documentTemplateParameters.tenantId, tenantId)));
  if (!param) throw new DomainError("parameter not found");

  const all = await listDocumentTemplateParameters(db, tenantId, param.templateId);
  const index = all.findIndex((p) => p.id === parameterId);
  const swapIndex = direction === "up" ? index - 1 : index + 1;
  if (swapIndex < 0 || swapIndex >= all.length) return all;

  const current = all[index]!;
  const other = all[swapIndex]!;
  await db.update(schema.documentTemplateParameters).set({ sortOrder: other.sortOrder }).where(eq(schema.documentTemplateParameters.id, current.id));
  await db.update(schema.documentTemplateParameters).set({ sortOrder: current.sortOrder }).where(eq(schema.documentTemplateParameters.id, other.id));

  return listDocumentTemplateParameters(db, tenantId, param.templateId);
}

export async function deleteDocumentTemplateParameter(db: TenantTx, tenantId: string, parameterId: string) {
  await db
    .delete(schema.documentTemplateParameters)
    .where(and(eq(schema.documentTemplateParameters.id, parameterId), eq(schema.documentTemplateParameters.tenantId, tenantId)));
}

/** Suggests a valid parameter key from a human-typed label ("Prepared by" -> "preparedBy")
 * - purely a UI convenience (the settings page pre-fills the key field with this, still
 * editable before saving), not itself enforced; `createDocumentTemplateParameter` always
 * re-validates whatever key actually gets submitted. */
export function suggestParameterKey(label: string): string {
  const words = label
    .trim()
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);
  if (words.length === 0) return "";
  const [first, ...rest] = words;
  const camel = [first!.toLowerCase(), ...rest.map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase())].join("");
  return /^[a-zA-Z]/.test(camel) ? camel : `p${camel}`;
}

/** Validates a set of raw parameter values (as submitted on the export form) against a
 * template's own parameter definitions - required-ness and, for a 'date' parameter, that
 * it actually parses as one. Returns a plain `{ key: value }` record ready to merge into
 * a Handlebars context as `params`, with `undefined` values dropped (a `date` type's
 * value is normalized to its `YYYY-MM-DD` prefix, matching the same convention custom
 * fields' own 'date' type already uses - see packages/core/src/custom-fields.ts). */
export function resolveDocumentTemplateParameterValues(
  definitions: Array<{ key: string; label: string; type: DocumentTemplateParameterType; isRequired: boolean }>,
  rawValues: Record<string, string | undefined>,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const def of definitions) {
    const raw = rawValues[def.key]?.trim();
    if (!raw) {
      if (def.isRequired) throw new DomainError(`"${def.label}" is required`);
      continue;
    }
    if (def.type === "date") {
      const datePart = raw.slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart) || Number.isNaN(Date.parse(datePart))) {
        throw new DomainError(`"${def.label}" must be a valid date (YYYY-MM-DD)`);
      }
      resolved[def.key] = datePart;
    } else {
      resolved[def.key] = raw;
    }
  }
  return resolved;
}
