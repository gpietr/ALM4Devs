"use client";

import { CUSTOM_FIELD_TYPE_OPTIONS, type CustomFieldDefinitionView } from "@/components/custom-fields";
import { SettingsSectionHeader } from "@/components/settings-shell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { trpc } from "@/lib/trpc-client";
import { ChevronDown, ChevronUp, Plus } from "lucide-react";
import { useState } from "react";

/**
 * Manage tenant-defined custom fields for requirements and test cases (backlog item
 * 9.19) - its own screen, same "multi-level navigation" reasoning as /settings/import's
 * hub + sub-screens: this is real, self-contained configuration work, not a couple of
 * toggles that belongs inline on the main settings page.
 */
export default function CustomFieldsSettingsPage() {
  return (
    <div>
      <SettingsSectionHeader
        title="Custom fields"
        description={
          <>
            Extra fields your team wants on every requirement or test case, beyond the built-in
            ones. Shown on the create/edit forms in the order set here, and as columns you can
            show or hide on the requirement/test case lists and the traceability matrix — each
            of those has a column picker covering every column, not just these. Values aren&apos;t
            versioned the way title/description are — editing one doesn&apos;t create a new
            version or need approval.
          </>
        }
      />

      <h3 className="text-base font-semibold tracking-tight">Requirement fields</h3>
      <CustomFieldsSection entityType="requirement" />

      <h3 className="mt-10 text-base font-semibold tracking-tight">Test case fields</h3>
      <CustomFieldsSection entityType="test_case" />
    </div>
  );
}

function CustomFieldsSection({ entityType }: { entityType: "requirement" | "test_case" }) {
  const utils = trpc.useUtils();
  const fields = trpc.settings.listCustomFields.useQuery({ entityType });

  const invalidate = () => utils.settings.listCustomFields.invalidate({ entityType });

  const createField = trpc.settings.createCustomField.useMutation({ onSuccess: invalidate });
  const renameField = trpc.settings.renameCustomField.useMutation({ onSuccess: invalidate });
  const setRequired = trpc.settings.setCustomFieldRequired.useMutation({ onSuccess: invalidate });
  const reorderField = trpc.settings.reorderCustomField.useMutation({ onSuccess: invalidate });
  const deleteField = trpc.settings.deleteCustomField.useMutation({ onSuccess: invalidate });

  const createOption = trpc.settings.createCustomFieldOption.useMutation({ onSuccess: invalidate });
  const renameOption = trpc.settings.renameCustomFieldOption.useMutation({ onSuccess: invalidate });
  const reorderOption = trpc.settings.reorderCustomFieldOption.useMutation({ onSuccess: invalidate });
  const deleteOption = trpc.settings.deleteCustomFieldOption.useMutation({ onSuccess: invalidate });

  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<CustomFieldDefinitionView["fieldType"]>("short_text");
  const [newRequired, setNewRequired] = useState(false);
  const [expandedOptionsFor, setExpandedOptionsFor] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [newOptionValue, setNewOptionValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (fields.isLoading) return <p className="mt-3 text-sm text-muted-foreground">Loading...</p>;
  const data = fields.data ?? [];

  return (
    <>
      <ul className="mt-4 divide-y divide-border overflow-hidden rounded-md border">
        {data.length === 0 && (
          <li className="px-3 py-3 text-sm text-muted-foreground">No custom fields yet.</li>
        )}
        {data.map((field, i) => (
          <li key={field.id}>
            <div className="flex items-center gap-3 px-3 py-2.5">
              <div className="flex flex-col">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  disabled={i === 0}
                  onClick={() => reorderField.mutate({ fieldId: field.id, direction: "up" })}
                  aria-label={`Move ${field.name} up`}
                >
                  <ChevronUp />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  disabled={i === data.length - 1}
                  onClick={() => reorderField.mutate({ fieldId: field.id, direction: "down" })}
                  aria-label={`Move ${field.name} down`}
                >
                  <ChevronDown />
                </Button>
              </div>

              {editingId === field.id ? (
                <form
                  className="flex flex-1 items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    renameField.mutate({ fieldId: field.id, name: editingName });
                    setEditingId(null);
                  }}
                >
                  <Input autoFocus value={editingName} onChange={(e) => setEditingName(e.target.value)} className="h-8 flex-1" />
                  <Button type="submit" variant="ghost" size="sm">Save</Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setEditingId(null)}>Cancel</Button>
                </form>
              ) : (
                <button
                  className="flex flex-1 items-center gap-2 text-left text-sm font-medium hover:underline"
                  onClick={() => {
                    setEditingId(field.id);
                    setEditingName(field.name);
                  }}
                >
                  {field.name}
                  <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground no-underline">
                    {CUSTOM_FIELD_TYPE_OPTIONS.find((t) => t.value === field.fieldType)?.label ?? field.fieldType}
                  </span>
                </button>
              )}

              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                Required
                <Switch
                  checked={field.isRequired}
                  onCheckedChange={(checked) => setRequired.mutate({ fieldId: field.id, isRequired: checked })}
                />
              </label>

              {field.fieldType === "list" && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setExpandedOptionsFor(expandedOptionsFor === field.id ? null : field.id)}
                >
                  {expandedOptionsFor === field.id ? "Hide options" : `Options (${field.options.length})`}
                </Button>
              )}

              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-destructive"
                onClick={() => {
                  if (
                    confirm(
                      `Delete "${field.name}"? This permanently deletes every value ever set for it on every ${
                        entityType === "requirement" ? "requirement" : "test case"
                      } - not just future ones.`,
                    )
                  ) {
                    deleteField.mutate({ fieldId: field.id });
                  }
                }}
              >
                Delete
              </Button>
            </div>

            {field.fieldType === "list" && expandedOptionsFor === field.id && (
              <div className="border-t bg-muted/30 px-3 py-3 pl-12">
                <ul className="space-y-1">
                  {field.options.map((option, oi) => (
                    <li key={option.id} className="flex items-center gap-2">
                      <div className="flex flex-col">
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          disabled={oi === 0}
                          onClick={() => reorderOption.mutate({ optionId: option.id, direction: "up" })}
                        >
                          <ChevronUp />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          disabled={oi === field.options.length - 1}
                          onClick={() => reorderOption.mutate({ optionId: option.id, direction: "down" })}
                        >
                          <ChevronDown />
                        </Button>
                      </div>
                      <Input
                        defaultValue={option.value}
                        className="h-7 flex-1 text-sm"
                        onBlur={(e) => {
                          if (e.target.value.trim() && e.target.value !== option.value) {
                            renameOption.mutate({ optionId: option.id, value: e.target.value });
                          }
                        }}
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => {
                          deleteOption.mutate(
                            { optionId: option.id },
                            {
                              onError: (err) => setError(err.message),
                            },
                          );
                        }}
                      >
                        Delete
                      </Button>
                    </li>
                  ))}
                  {field.options.length === 0 && (
                    <li className="text-xs text-muted-foreground">No options yet - add one below.</li>
                  )}
                </ul>
                <form
                  className="mt-2 flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!newOptionValue.trim()) return;
                    createOption.mutate(
                      { fieldId: field.id, value: newOptionValue },
                      { onSuccess: () => setNewOptionValue(""), onError: (err) => setError(err.message) },
                    );
                  }}
                >
                  <Input
                    value={newOptionValue}
                    onChange={(e) => setNewOptionValue(e.target.value)}
                    placeholder="New option"
                    className="h-7 flex-1 text-sm"
                  />
                  <Button type="submit" variant="outline" size="sm" disabled={!newOptionValue.trim()}>
                    Add
                  </Button>
                </form>
              </div>
            )}
          </li>
        ))}
      </ul>

      <form
        className="mt-3 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!newName.trim()) return;
          createField.mutate(
            { entityType, name: newName, fieldType: newType, isRequired: newRequired },
            {
              onSuccess: () => {
                setNewName("");
                setNewType("short_text");
                setNewRequired(false);
              },
              onError: (err) => setError(err.message),
            },
          );
        }}
      >
        <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New field name" className="w-48" />
        <Select value={newType} onValueChange={(v) => setNewType((v as CustomFieldDefinitionView["fieldType"]) ?? "short_text")}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CUSTOM_FIELD_TYPE_OPTIONS.map((t) => (
              <SelectItem key={t.value} value={t.value}>
                {t.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          Required
          <Switch checked={newRequired} onCheckedChange={setNewRequired} />
        </label>
        <Button type="submit" variant="outline" disabled={!newName.trim()} className="gap-1">
          <Plus className="size-3.5" />
          Add field
        </Button>
      </form>
      {(error || createField.error || renameField.error || deleteField.error) && (
        <p className="mt-2 text-sm text-destructive">
          {error ?? createField.error?.message ?? renameField.error?.message ?? deleteField.error?.message}
        </p>
      )}
    </>
  );
}
