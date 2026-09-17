"use client";

import { SettingsSectionHeader } from "@/components/settings-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc-client";
import { ChevronDown, ChevronUp, Plus } from "lucide-react";
import { useEffect, useState } from "react";

type Scope = "test_case" | "test_execution" | "requirement_list";
type ParamType = "text" | "date";

const HANDLEBARS_DOCS_URL = "https://handlebarsjs.com/guide/expressions.html";

/** A field available to a scope's Handlebars context - `html: true` marks one that's
 * already-sanitized rich-text HTML (a description, a step, a background) and therefore
 * needs the unescaped triple-stash form (`{{{this.field}}}`), not the normal escaped one
 * (`{{field}}`) - see the Legend rendered from this same list, and
 * packages/core/src/document-context.ts for where each field actually comes from. */
interface PlaceholderField {
  path: string;
  html?: boolean;
  note?: string;
}

const PLACEHOLDER_FIELDS: Record<Scope, PlaceholderField[]> = {
  test_case: [
    { path: "displayId" },
    { path: "title" },
    { path: "levelName" },
    { path: "generatedAt" },
    { path: "#each steps", note: "loop" },
    { path: "  this.position" },
    { path: "  this.description", html: true },
    { path: "  this.expectedResult", html: true },
    { path: "  this.purpose" },
    { path: "#each requirements", note: "loop - linked requirements" },
    { path: "  this.displayId" },
    { path: "  this.title" },
    { path: "#each customFields", note: "loop" },
    { path: "  this.name" },
    { path: "  this.value" },
  ],
  test_execution: [
    { path: "testCase.displayId" },
    { path: "testCase.title" },
    { path: "status" },
    { path: "environment" },
    { path: "executedBy" },
    { path: "startedAt" },
    { path: "completedAt" },
    { path: "generatedAt" },
    { path: "#each steps", note: "loop" },
    { path: "  this.position" },
    { path: "  this.description", html: true },
    { path: "  this.expectedResult", html: true },
    { path: "  this.actualResult", html: true },
    { path: "  this.status" },
    { path: "  this.recordedAt" },
    { path: "  this.evidenceFilenames", note: "a list of filenames - enumerate with {{#each this.evidenceFilenames}}{{this}}{{/each}}" },
  ],
  requirement_list: [
    { path: "productName" },
    { path: "levelName" },
    { path: "generatedAt" },
    { path: "#each requirements", note: "loop" },
    { path: "  this.displayId" },
    { path: "  this.title" },
    { path: "  this.description", html: true },
    { path: "  this.background", html: true },
    { path: "  this.status" },
    { path: "  #each this.customFields", note: "nested loop" },
    { path: "    this.name" },
    { path: "    this.value" },
  ],
};

/** Seeded onto a newly-created template so bulk generation (backlog item 9.32) produces
 * distinct, meaningful filenames out of the box, without the operator having to discover
 * the filename field first - a static name (the template's own `name`, the old default)
 * would collide across every file in a zip. Still just a starting point, editable like
 * everything else. */
const DEFAULT_FILENAME_TEMPLATE: Record<Scope, string> = {
  test_case: "{{displayId}} - {{title}}",
  test_execution: "{{testCase.displayId}} - {{testCase.title}} - {{status}}",
  requirement_list: "{{productName}} - {{levelName}}",
};

const SCOPES: Array<{ value: Scope; label: string; description: string }> = [
  { value: "test_case", label: "Test case", description: "Generated from one test case's own definition (title, steps, linked requirements) - no execution or run results." },
  { value: "test_execution", label: "Test execution", description: "Generated from one recorded run of a test case - actual results, status, evidence filenames." },
  { value: "requirement_list", label: "Requirement list", description: "Generated from whatever a requirements list is currently showing (respecting its filters) - a spec or coverage-style document." },
];

/**
 * Manage tenant-defined PDF document templates (backlog item 9.29) - own screen, same
 * "real, self-contained configuration work" reasoning as /settings/custom-fields.
 * Generation itself happens from each document's own page (a test case, a test
 * execution, or a requirements list), not here - this only defines the templates and
 * their fill-in-at-export-time parameters.
 */
export default function DocumentTemplatesSettingsPage() {
  return (
    <div>
      <SettingsSectionHeader
        title="Document templates"
        description={
          <>
            Your own HTML (with CSS), using Handlebars placeholders, rendered against real
            data and converted to PDF. Nothing generated is ever stored — it&apos;s downloaded
            once and gone.
          </>
        }
      />

      <div className="rounded-md border">
        <div className="border-b bg-muted/40 px-3 py-1.5 text-xs font-medium text-muted-foreground">
          Legend
        </div>
        <table className="w-full text-xs">
          <tbody className="divide-y divide-border">
            <tr>
              <td className="w-40 px-3 py-1.5 font-mono">{"{{value}}"}</td>
              <td className="px-3 py-1.5 text-muted-foreground">Escaped text - use for any plain field (a title, a status, a parameter).</td>
            </tr>
            <tr>
              <td className="px-3 py-1.5 font-mono">{"{{{value}}}"}</td>
              <td className="px-3 py-1.5 text-muted-foreground">
                Raw, unescaped HTML - use for a field marked <span className="rounded bg-amber-100 px-1 text-amber-900">HTML</span> below
                (a description, a step, a background - already-sanitized rich text).
              </td>
            </tr>
            <tr>
              <td className="px-3 py-1.5 font-mono">{"{{#each list}}...{{/each}}"}</td>
              <td className="px-3 py-1.5 text-muted-foreground">Repeats the block once per item in a list field (e.g. steps, requirements).</td>
            </tr>
            <tr>
              <td className="px-3 py-1.5 font-mono">{"{{this.field}}"}</td>
              <td className="px-3 py-1.5 text-muted-foreground">A field on the current item, inside an {"{{#each}}"} block.</td>
            </tr>
            <tr>
              <td className="px-3 py-1.5 font-mono">{"{{params.key}}"}</td>
              <td className="px-3 py-1.5 text-muted-foreground">A parameter you define on the template below, by its key.</td>
            </tr>
          </tbody>
        </table>
        <div className="border-t bg-muted/40 px-3 py-1.5 text-xs">
          <a href={HANDLEBARS_DOCS_URL} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
            Full Handlebars syntax reference →
          </a>
        </div>
      </div>

      {SCOPES.map((s) => (
        <section key={s.value} className="mt-10">
          <h3 className="text-base font-semibold tracking-tight">{s.label}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{s.description}</p>
          <ScopeSection scope={s.value} />
        </section>
      ))}
    </div>
  );
}

function ScopeSection({ scope }: { scope: Scope }) {
  const utils = trpc.useUtils();
  const templates = trpc.documentTemplates.list.useQuery({ scope });
  const invalidate = () => utils.documentTemplates.list.invalidate({ scope });

  const createTemplate = trpc.documentTemplates.create.useMutation({ onSuccess: invalidate });
  const [newName, setNewName] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (templates.isLoading) return <p className="mt-3 text-sm text-muted-foreground">Loading...</p>;
  const data = templates.data ?? [];

  return (
    <>
      <ul className="mt-4 divide-y divide-border overflow-hidden rounded-md border">
        {data.length === 0 && <li className="px-3 py-3 text-sm text-muted-foreground">No templates yet.</li>}
        {data.map((template) => (
          <TemplateRow
            key={template.id}
            template={template}
            scope={scope}
            expanded={expandedId === template.id}
            onToggle={() => setExpandedId(expandedId === template.id ? null : template.id)}
            onInvalidate={invalidate}
            onError={setError}
          />
        ))}
      </ul>

      <form
        className="mt-3 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!newName.trim()) return;
          createTemplate.mutate(
            {
              scope,
              name: newName,
              htmlTemplate: "<h1>{{title}}</h1>\n<p>Generated {{generatedAt}}</p>\n",
              filenameTemplate: DEFAULT_FILENAME_TEMPLATE[scope],
            },
            {
              onSuccess: (t) => {
                setNewName("");
                setExpandedId(t.id);
              },
              onError: (err) => setError(err.message),
            },
          );
        }}
      >
        <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New template name" className="w-56" />
        <Button type="submit" variant="outline" disabled={!newName.trim()} className="gap-1">
          <Plus className="size-3.5" />
          Add template
        </Button>
      </form>
      {(error || createTemplate.error) && (
        <p className="mt-2 text-sm text-destructive">{error ?? createTemplate.error?.message}</p>
      )}
    </>
  );
}

interface TemplateListItem {
  id: string;
  name: string;
  htmlTemplate: string;
  filenameTemplate: string | null;
  parameters: Array<{ id: string; key: string; label: string; type: string; isRequired: boolean; sortOrder: number }>;
}

function TemplateRow({
  template,
  scope,
  expanded,
  onToggle,
  onInvalidate,
  onError,
}: {
  template: TemplateListItem;
  scope: Scope;
  expanded: boolean;
  onToggle: () => void;
  onInvalidate: () => void;
  onError: (msg: string) => void;
}) {
  const renameTemplate = trpc.documentTemplates.rename.useMutation({ onSuccess: onInvalidate });
  const updateHtml = trpc.documentTemplates.updateHtml.useMutation({ onSuccess: onInvalidate });
  const updateFilename = trpc.documentTemplates.updateFilename.useMutation({ onSuccess: onInvalidate });
  const deleteTemplate = trpc.documentTemplates.delete.useMutation({ onSuccess: onInvalidate });
  const createParameter = trpc.documentTemplates.createParameter.useMutation({ onSuccess: onInvalidate });
  const updateParameter = trpc.documentTemplates.updateParameter.useMutation({ onSuccess: onInvalidate });
  const reorderParameter = trpc.documentTemplates.reorderParameter.useMutation({ onSuccess: onInvalidate });
  const deleteParameter = trpc.documentTemplates.deleteParameter.useMutation({ onSuccess: onInvalidate });

  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(template.name);
  const [htmlDraft, setHtmlDraft] = useState(template.htmlTemplate);
  const [filenameDraft, setFilenameDraft] = useState(template.filenameTemplate ?? "");
  const [newParamLabel, setNewParamLabel] = useState("");
  const [newParamKey, setNewParamKey] = useState("");
  const [newParamType, setNewParamType] = useState<ParamType>("text");
  const [newParamRequired, setNewParamRequired] = useState(false);

  const htmlDirty = htmlDraft !== template.htmlTemplate;
  const filenameDirty = filenameDraft !== (template.filenameTemplate ?? "");

  return (
    <li>
      <div className="flex items-center gap-3 px-3 py-2.5">
        {editingName ? (
          <form
            className="flex flex-1 items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              renameTemplate.mutate({ id: template.id, name: nameDraft }, { onSuccess: () => setEditingName(false), onError: (err) => onError(err.message) });
            }}
          >
            <Input autoFocus value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} className="h-8 flex-1" />
            <Button type="submit" variant="ghost" size="sm">Save</Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditingName(false)}>Cancel</Button>
          </form>
        ) : (
          <button
            className="flex-1 text-left text-sm font-medium hover:underline"
            onClick={() => {
              setEditingName(true);
              setNameDraft(template.name);
            }}
          >
            {template.name}
          </button>
        )}
        <Button variant="ghost" size="sm" onClick={onToggle}>
          {expanded ? "Hide" : "Edit"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:text-destructive"
          onClick={() => {
            if (confirm(`Delete template "${template.name}"?`)) deleteTemplate.mutate({ id: template.id });
          }}
        >
          Delete
        </Button>
      </div>

      {expanded && (
        <div className="space-y-4 border-t bg-muted/30 px-3 py-4">
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">
              Available fields for this document type - see the Legend above for {"{{value}}"} vs {"{{{value}}}"}
            </p>
            <div className="overflow-hidden rounded border bg-background">
              <table className="w-full text-[11px]">
                <tbody className="divide-y divide-border">
                  {PLACEHOLDER_FIELDS[scope].map((f) => (
                    <tr key={f.path}>
                      <td className="whitespace-pre px-2 py-1 font-mono text-muted-foreground">{`{{${f.path}}}`}</td>
                      <td className="w-14 px-2 py-1">
                        {f.html && <span className="rounded bg-amber-100 px-1 text-amber-900">HTML</span>}
                      </td>
                      <td className="px-2 py-1 text-muted-foreground">{f.note}</td>
                    </tr>
                  ))}
                  <tr>
                    <td className="whitespace-pre px-2 py-1 font-mono text-muted-foreground">{"{{params.<key>}}"}</td>
                    <td className="px-2 py-1" />
                    <td className="px-2 py-1 text-muted-foreground">any parameter defined below, by its key</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">
              Filename format - also Handlebars, rendered per generated file (see the live
              preview&apos;s filename below). Escaping is off here (it&apos;s a filename, not
              HTML) and characters a filesystem can&apos;t use are stripped automatically.
              Leave blank to just use the template name for every file.
            </p>
            <Input
              value={filenameDraft}
              onChange={(e) => setFilenameDraft(e.target.value)}
              placeholder={DEFAULT_FILENAME_TEMPLATE[scope]}
              className="font-mono text-xs"
            />
            <div className="mt-1.5 flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={!filenameDirty || updateFilename.isPending}
                onClick={() =>
                  updateFilename.mutate({ id: template.id, filenameTemplate: filenameDraft }, { onError: (err) => onError(err.message) })
                }
              >
                {updateFilename.isPending ? "Saving..." : "Save filename format"}
              </Button>
              {filenameDirty && (
                <Button size="sm" variant="ghost" onClick={() => setFilenameDraft(template.filenameTemplate ?? "")}>
                  Discard changes
                </Button>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">HTML template</p>
              <Textarea
                value={htmlDraft}
                onChange={(e) => setHtmlDraft(e.target.value)}
                rows={18}
                className="font-mono text-xs"
                spellCheck={false}
              />
              <div className="mt-1.5 flex items-center gap-2">
                <Button
                  size="sm"
                  disabled={!htmlDirty || updateHtml.isPending}
                  onClick={() => updateHtml.mutate({ id: template.id, htmlTemplate: htmlDraft }, { onError: (err) => onError(err.message) })}
                >
                  {updateHtml.isPending ? "Saving..." : "Save template"}
                </Button>
                {htmlDirty && (
                  <Button size="sm" variant="ghost" onClick={() => setHtmlDraft(template.htmlTemplate)}>
                    Discard changes
                  </Button>
                )}
              </div>
            </div>

            <TemplatePreviewPane
              scope={scope}
              templateId={template.id}
              htmlTemplate={htmlDraft}
              filenameTemplate={filenameDraft}
              parameters={template.parameters}
            />
          </div>

          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">
              Parameters - filled in on a small form each time this template is used
            </p>
            <ul className="divide-y divide-border overflow-hidden rounded-md border bg-background">
              {template.parameters.length === 0 && (
                <li className="px-3 py-2 text-xs text-muted-foreground">No parameters - the export form for this template will only show a Generate button.</li>
              )}
              {template.parameters.map((param, i) => (
                <li key={param.id} className="flex items-center gap-2 px-3 py-2">
                  <div className="flex flex-col">
                    <Button variant="ghost" size="icon-xs" disabled={i === 0} onClick={() => reorderParameter.mutate({ id: param.id, direction: "up" })}>
                      <ChevronUp />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      disabled={i === template.parameters.length - 1}
                      onClick={() => reorderParameter.mutate({ id: param.id, direction: "down" })}
                    >
                      <ChevronDown />
                    </Button>
                  </div>
                  <Input
                    defaultValue={param.label}
                    className="h-7 flex-1 text-sm"
                    onBlur={(e) => {
                      if (e.target.value.trim() && e.target.value !== param.label) {
                        updateParameter.mutate({ id: param.id, label: e.target.value }, { onError: (err) => onError(err.message) });
                      }
                    }}
                  />
                  <code className="whitespace-nowrap rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                    {`{{params.${param.key}}}`}
                  </code>
                  <Select
                    value={param.type}
                    onValueChange={(v) => updateParameter.mutate({ id: param.id, type: (v as ParamType) ?? "text" })}
                  >
                    <SelectTrigger className="h-7 w-24 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="text">Text</SelectItem>
                      <SelectItem value="date">Date</SelectItem>
                    </SelectContent>
                  </Select>
                  <label className="flex items-center gap-1 text-xs text-muted-foreground">
                    Required
                    <Switch
                      checked={param.isRequired}
                      onCheckedChange={(checked) => updateParameter.mutate({ id: param.id, isRequired: checked })}
                    />
                  </label>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => deleteParameter.mutate({ id: param.id })}
                  >
                    Delete
                  </Button>
                </li>
              ))}
            </ul>
            <form
              className="mt-2 flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!newParamLabel.trim() || !newParamKey.trim()) return;
                createParameter.mutate(
                  { templateId: template.id, key: newParamKey, label: newParamLabel, type: newParamType, isRequired: newParamRequired },
                  {
                    onSuccess: () => {
                      setNewParamLabel("");
                      setNewParamKey("");
                      setNewParamType("text");
                      setNewParamRequired(false);
                    },
                    onError: (err) => onError(err.message),
                  },
                );
              }}
            >
              <Input
                value={newParamLabel}
                onChange={(e) => {
                  const label = e.target.value;
                  setNewParamLabel(label);
                  // Only auto-fill the key while the operator hasn't hand-edited it yet -
                  // once they've typed their own key, typing more of the label shouldn't
                  // silently overwrite it.
                  setNewParamKey((prevKey) => (prevKey === suggestKeyLocally(newParamLabel) ? suggestKeyLocally(label) : prevKey));
                }}
                placeholder="Label (e.g. Prepared by)"
                className="h-7 w-44 text-xs"
              />
              <Input
                value={newParamKey}
                onChange={(e) => setNewParamKey(e.target.value)}
                placeholder="key"
                className="h-7 w-28 font-mono text-xs"
              />
              <Select value={newParamType} onValueChange={(v) => setNewParamType((v as ParamType) ?? "text")}>
                <SelectTrigger className="h-7 w-24 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="text">Text</SelectItem>
                  <SelectItem value="date">Date</SelectItem>
                </SelectContent>
              </Select>
              <label className="flex items-center gap-1 text-xs text-muted-foreground">
                Required
                <Switch checked={newParamRequired} onCheckedChange={setNewParamRequired} />
              </label>
              <Button type="submit" variant="outline" size="sm" disabled={!newParamLabel.trim() || !newParamKey.trim()}>
                Add parameter
              </Button>
            </form>
          </div>
        </div>
      )}
    </li>
  );
}

interface PreviewParameter {
  id: string;
  key: string;
  label: string;
  type: string;
  isRequired: boolean;
}

/**
 * Live "as you make changes" preview (backlog item 9.30), to the right of the editor -
 * renders the Handlebars template against a real example the operator picks (a test
 * case, an execution, or a product+level's requirements), debounced so it doesn't
 * re-render on every single keystroke. Deliberately HTML-only, not a real PDF: spawning
 * wkhtmltopdf on every keystroke would be slow and wasteful (it's a real subprocess per
 * call) - the actual "Generate document" buttons on each entity's own page already give
 * an exact, real PDF when that's what's needed. The preview may differ slightly from the
 * final PDF in fonts or complex CSS (wkhtmltopdf's own rendering engine vs. this iframe's
 * browser one) but matches for the plain headings/paragraphs/tables layout these
 * templates are meant for.
 */
function TemplatePreviewPane({
  scope,
  templateId,
  htmlTemplate,
  filenameTemplate,
  parameters,
}: {
  scope: Scope;
  templateId: string;
  htmlTemplate: string;
  filenameTemplate: string;
  parameters: PreviewParameter[];
}) {
  const [testCaseId, setTestCaseId] = useState("");
  const [executionId, setExecutionId] = useState("");
  const [productId, setProductId] = useState("");
  const [levelId, setLevelId] = useState("");
  const [previewParamValues, setPreviewParamValues] = useState<Record<string, string>>({});

  const exampleTestCases = trpc.documentTemplates.listExampleTestCases.useQuery(undefined, { enabled: scope === "test_case" });
  const exampleExecutions = trpc.documentTemplates.listExampleExecutions.useQuery(undefined, { enabled: scope === "test_execution" });
  const products = trpc.products.list.useQuery(undefined, { enabled: scope === "requirement_list" });
  const levels = trpc.requirements.listLevels.useQuery(undefined, { enabled: scope === "requirement_list" });
  const requirementsForLevel = trpc.requirements.listByProduct.useQuery(
    { productId, levelId },
    { enabled: scope === "requirement_list" && Boolean(productId) && Boolean(levelId) },
  );

  const previewHtml = trpc.documentTemplates.previewHtml.useMutation();

  // Debounced: re-renders the preview ~500ms after the last change to the template body,
  // the chosen example, or a preview parameter value - not on every keystroke.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const requirementIds = (requirementsForLevel.data ?? []).slice(0, 5).map((r) => r.id);
    const hasExample =
      (scope === "test_case" && testCaseId) ||
      (scope === "test_execution" && executionId) ||
      (scope === "requirement_list" && requirementIds.length > 0);
    if (!hasExample) return;

    const handle = setTimeout(() => {
      previewHtml.mutate({
        templateId,
        htmlTemplate,
        filenameTemplate,
        testCaseId: scope === "test_case" ? testCaseId : undefined,
        executionId: scope === "test_execution" ? executionId : undefined,
        requirementIds: scope === "requirement_list" ? requirementIds : undefined,
        productId: scope === "requirement_list" ? productId : undefined,
        levelId: scope === "requirement_list" ? levelId : undefined,
        paramValues: previewParamValues,
      });
    }, 500);
    return () => clearTimeout(handle);
  }, [
    scope,
    templateId,
    htmlTemplate,
    filenameTemplate,
    testCaseId,
    executionId,
    productId,
    levelId,
    requirementsForLevel.data,
    previewParamValues,
  ]);

  return (
    <div>
      <p className="mb-1 text-xs font-medium text-muted-foreground">Live preview</p>
      <div className="flex flex-wrap items-center gap-2 rounded-t-md border border-b-0 bg-background px-2 py-1.5">
        {scope === "test_case" && (
          <Select value={testCaseId} onValueChange={(v) => v && setTestCaseId(v)}>
            <SelectTrigger className="h-7 w-56 text-xs">
              <SelectValue placeholder="Pick an example test case" />
            </SelectTrigger>
            <SelectContent>
              {(exampleTestCases.data ?? []).map((tc) => (
                <SelectItem key={tc.id} value={tc.id}>
                  {tc.levelCode}-{tc.sequenceNumber}: {tc.title} ({tc.productName})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {scope === "test_execution" && (
          <Select value={executionId} onValueChange={(v) => v && setExecutionId(v)}>
            <SelectTrigger className="h-7 w-64 text-xs">
              <SelectValue placeholder="Pick an example execution" />
            </SelectTrigger>
            <SelectContent>
              {(exampleExecutions.data ?? []).map((ex) => (
                <SelectItem key={ex.id} value={ex.id}>
                  {ex.levelCode}-{ex.testCaseSequenceNumber}: {ex.testCaseTitle} - {ex.status}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {scope === "requirement_list" && (
          <>
            <Select
              value={productId}
              onValueChange={(v) => {
                setProductId(v ?? "");
                setLevelId("");
              }}
            >
              <SelectTrigger className="h-7 w-36 text-xs">
                <SelectValue placeholder="Product" />
              </SelectTrigger>
              <SelectContent>
                {(products.data ?? []).map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={levelId} onValueChange={(v) => setLevelId(v ?? "")}>
              <SelectTrigger className="h-7 w-36 text-xs">
                <SelectValue placeholder="Level" />
              </SelectTrigger>
              <SelectContent>
                {(levels.data ?? []).map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {productId && levelId && (
              <span className="text-[11px] text-muted-foreground">
                {(requirementsForLevel.data ?? []).length === 0
                  ? "No requirements in this level"
                  : `previewing up to 5 of ${requirementsForLevel.data?.length}`}
              </span>
            )}
          </>
        )}
        {parameters.map((p) => (
          <label key={p.id} className="flex items-center gap-1 text-[11px] text-muted-foreground">
            {p.label}
            <Input
              type={p.type === "date" ? "date" : "text"}
              value={previewParamValues[p.key] ?? ""}
              onChange={(e) => setPreviewParamValues((v) => ({ ...v, [p.key]: e.target.value }))}
              className="h-6 w-28 text-[11px]"
            />
          </label>
        ))}
      </div>
      {previewHtml.data?.filename && (
        <p className="border-x border-t bg-background px-2 py-1 font-mono text-[11px] text-muted-foreground">
          Filename: {previewHtml.data.filename}
        </p>
      )}
      <div className="h-[420px] overflow-hidden rounded-b-md border bg-white">
        {previewHtml.data?.error ? (
          <p className="p-3 text-xs text-destructive">{previewHtml.data.error}</p>
        ) : previewHtml.data?.html ? (
          <iframe title="Template preview" srcDoc={previewHtml.data.html} sandbox="" className="size-full" />
        ) : (
          <p className="p-3 text-xs text-muted-foreground">Pick an example above to see a live preview.</p>
        )}
      </div>
    </div>
  );
}

/** Mirrors packages/core/src/document-templates.ts's `suggestParameterKey` exactly (kept
 * as a small standalone copy, not imported from @galm/core, to avoid pulling that
 * barrel's `@galm/db` dependency into the client bundle - the same client-bundle-safety
 * pattern already used for format-item-id.ts and CUSTOM_FIELD_TYPE_OPTIONS) - used only
 * to decide whether the key field still matches what auto-fill would produce, so typing
 * more of the label doesn't clobber a key the operator already hand-edited. */
function suggestKeyLocally(label: string): string {
  const words = label
    .trim()
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);
  if (words.length === 0) return "";
  const [first, ...rest] = words;
  const camel = [first!.toLowerCase(), ...rest.map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase())].join("");
  return /^[a-zA-Z]/.test(camel) ? camel : `p${camel}`;
}
