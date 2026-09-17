"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

/**
 * Shared across every place tenant-defined fields (backlog item 9.19) show up: the
 * create/edit form inputs and the read-only value formatter (list tables, the
 * traceability matrix, the detail pages). Kept in one file since both are thin
 * wrappers around the same `CustomFieldDefinitionView` shape
 * (`settings.listCustomFields`'s output). Column visibility for those tables lives
 * in column-picker.tsx - tenant-defined fields are just more columns, not a separate
 * picker.
 */

export interface CustomFieldOption {
  id: string;
  value: string;
  sortOrder: number;
}

export interface CustomFieldDefinitionView {
  id: string;
  entityType: string;
  name: string;
  fieldType: "short_text" | "long_text" | "list" | "date" | "integer" | "boolean";
  isRequired: boolean;
  sortOrder: number;
  options: CustomFieldOption[];
}

/** `settings.listCustomFields`'s inferred tRPC output types `fieldType` as plain
 * `string` (it comes off a `text` column - Drizzle/tRPC don't know about the CHECK
 * constraint restricting it), same as every other CHECK-constrained-but-DB-untyped
 * column elsewhere in this app (status.category, custom_field_definitions.entity_type,
 * ...). This is the one place that trusts the constraint and narrows it back for every
 * caller, rather than each call site repeating its own `as` cast. */
export function asCustomFieldDefinitions(
  rows: ReadonlyArray<Omit<CustomFieldDefinitionView, "fieldType"> & { fieldType: string }>,
): CustomFieldDefinitionView[] {
  return rows as CustomFieldDefinitionView[];
}

/** Deliberately a standalone copy of @galm/core's CUSTOM_FIELD_TYPES, not an import of
 * it - this file is used from client components, and @galm/core's barrel
 * unconditionally re-exports server-only modules that pull in Bun's native Postgres
 * client (same issue documented on apps/web/src/lib/format-item-id.ts, which hit exactly
 * this as a real production-build break earlier). Keep the two lists in sync if the set
 * of field types ever changes. */
export const CUSTOM_FIELD_TYPE_OPTIONS: ReadonlyArray<{ value: CustomFieldDefinitionView["fieldType"]; label: string }> = [
  { value: "short_text", label: "Short text" },
  { value: "long_text", label: "Long text" },
  { value: "list", label: "List (single choice)" },
  { value: "date", label: "Date" },
  { value: "integer", label: "Integer" },
  { value: "boolean", label: "Yes/No" },
];

/** The shape getCustomFieldValues/getCustomFieldValuesForEntities (packages/core) return
 * over tRPC - present on requirements.get/listByProduct, testCases.get/listByProduct, and
 * the traceability matrix's rows. */
export interface CustomFieldValueView {
  fieldId: string;
  name: string;
  fieldType: CustomFieldDefinitionView["fieldType"];
  isRequired: boolean;
  value: string | null;
  optionLabel: string | null;
}

/** What a create/edit form collects locally: fieldId -> the raw UI value (a string for
 * short_text/long_text/date/integer, the selected option's id for list, a real boolean
 * for boolean). Converted to the tRPC `customFieldValues` array shape at submit time via
 * toCustomFieldValuesInput. */
export type CustomFieldFormState = Record<string, string | boolean | undefined>;

export function emptyCustomFieldFormState(fields: CustomFieldDefinitionView[]): CustomFieldFormState {
  const state: CustomFieldFormState = {};
  for (const f of fields) state[f.id] = f.fieldType === "boolean" ? false : "";
  return state;
}

/** Seeds form state from a detail page's already-set values. */
export function customFieldFormStateFromValues(values: CustomFieldValueView[]): CustomFieldFormState {
  const state: CustomFieldFormState = {};
  for (const v of values) {
    state[v.fieldId] = v.fieldType === "boolean" ? v.value === "true" : (v.value ?? "");
  }
  return state;
}

export function toCustomFieldValuesInput(
  state: CustomFieldFormState,
): Array<{ fieldId: string; value: string | number | boolean | null }> {
  return Object.entries(state).map(([fieldId, value]) => ({
    fieldId,
    value: value === "" || value === undefined ? null : value,
  }));
}

/** Read-only rendering of one value - list tables, the traceability matrix, and the
 * detail pages' read view all format a value the same way. */
export function formatCustomFieldValue(view: Pick<CustomFieldValueView, "fieldType" | "value" | "optionLabel">): string {
  if (view.value == null) return "—";
  if (view.fieldType === "boolean") return view.value === "true" ? "Yes" : "No";
  if (view.fieldType === "list") return view.optionLabel ?? "—";
  return view.value;
}

const NONE_OPTION = "__none__";

function CustomFieldInput({
  field,
  value,
  onChange,
}: {
  field: CustomFieldDefinitionView;
  value: string | boolean | undefined;
  onChange: (value: string | boolean) => void;
}) {
  switch (field.fieldType) {
    case "short_text":
      return (
        <Input
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value)}
          required={field.isRequired}
        />
      );
    case "long_text":
      return (
        <Textarea
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          required={field.isRequired}
        />
      );
    case "integer":
      return (
        <Input
          type="number"
          step={1}
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value)}
          required={field.isRequired}
        />
      );
    case "date":
      return (
        <Input
          type="date"
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value)}
          required={field.isRequired}
        />
      );
    case "boolean":
      return <Switch checked={!!value} onCheckedChange={(checked) => onChange(checked)} />;
    case "list": {
      const current = (value as string) || "";
      return (
        <Select
          value={field.isRequired ? current || undefined : current || NONE_OPTION}
          onValueChange={(v) => onChange(v === NONE_OPTION ? "" : (v ?? ""))}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Select..." />
          </SelectTrigger>
          <SelectContent>
            {!field.isRequired && <SelectItem value={NONE_OPTION}>— none —</SelectItem>}
            {field.options.map((o) => (
              <SelectItem key={o.id} value={o.id}>
                {o.value}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    }
  }
}

/** The full set of input rows for a create/edit form - every defined field for one
 * entity type, in display order, each labeled with its name and (if required) a marker.
 * Renders nothing when there are no defined fields, so a tenant that hasn't added any
 * sees no change to the form at all. */
export function CustomFieldInputs({
  fields,
  state,
  onChange,
}: {
  fields: CustomFieldDefinitionView[];
  state: CustomFieldFormState;
  onChange: (fieldId: string, value: string | boolean) => void;
}) {
  if (fields.length === 0) return null;
  return (
    <div className="space-y-3">
      {fields.map((field) => (
        <Label key={field.id} className="flex-col items-start gap-1">
          <span className="text-xs font-medium text-muted-foreground">
            {field.name}
            {field.isRequired && <span className="text-destructive"> *</span>}
          </span>
          <CustomFieldInput field={field} value={state[field.id]} onChange={(v) => onChange(field.id, v)} />
        </Label>
      ))}
    </div>
  );
}

/** Read-only counterpart of CustomFieldInputs - same labels, values formatted the way
 * list tables already format them. */
export function CustomFieldReadout({ values }: { values: CustomFieldValueView[] }) {
  if (values.length === 0) return null;
  return (
    <div className="space-y-3">
      {values.map((v) => (
        <div key={v.fieldId}>
          <p className="text-xs font-medium text-muted-foreground">{v.name}</p>
          <p className="text-sm text-foreground/90">{formatCustomFieldValue(v)}</p>
        </div>
      ))}
    </div>
  );
}
