"use client";

import { TopBar } from "@/components/context-strip";
import { asCustomFieldDefinitions } from "@/components/custom-fields";
import { RichTextView } from "@/components/rich-text-view";
import {
  actionCount,
  actionClassName,
  ConnectionStatusNote,
  MappingSelect,
  resultLabel,
  useChunkedSpiraImport,
} from "@/components/spira-import-shared";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { trpc } from "@/lib/trpc-client";
import type { ImportRowResult } from "@galm/integrations-spira";
import Link from "next/link";
import { useState } from "react";

interface Mapping {
  title: string;
  description: string;
  background: string;
  legacyId: string;
}

const EMPTY_MAPPING: Mapping = { title: "", description: "", background: "", legacyId: "" };

export default function SpiraImportRequirementsPage() {
  const connection = trpc.spiraImport.getConnection.useQuery();
  const fields = trpc.spiraImport.listFields.useQuery(undefined, { enabled: false });

  const products = trpc.products.list.useQuery();
  const levels = trpc.requirements.listLevels.useQuery();
  const customFieldsQuery = trpc.settings.listCustomFields.useQuery({ entityType: "requirement" });
  const customFields = asCustomFieldDefinitions(customFieldsQuery.data ?? []);

  const preview = trpc.spiraImport.preview.useMutation();
  const runImportMutation = trpc.spiraImport.run.useMutation();
  const countRequirements = trpc.spiraImport.countRequirements.useQuery(undefined, { enabled: false });
  const runImport = useChunkedSpiraImport<ImportRowResult>();

  const [productId, setProductId] = useState("");
  const [levelId, setLevelId] = useState("");
  const [mapping, setMapping] = useState<Mapping>(EMPTY_MAPPING);
  const [startRow, setStartRow] = useState(1);
  // Our custom field id -> the Spira field key mapped to feed it - a plain record since
  // custom fields are tenant-defined and dynamic, unlike the other, fixed mapping targets
  // above. See RequirementFieldMapping.customFields (packages/integrations/spira).
  const [customFieldMapping, setCustomFieldMapping] = useState<Record<string, string>>({});

  const mappingReady = mapping.title !== "" && mapping.description !== "";

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-3xl px-4 py-10">
      <Link href="/settings/import" className="text-sm text-muted-foreground underline underline-offset-2">
        ← Import
      </Link>
      <h1 className="mt-2 text-xl font-semibold tracking-tight">Import requirements from Spira</h1>
      <div className="mt-2">
        <ConnectionStatusNote connection={connection} />
      </div>

      {/* --- Target + fields + mapping --- */}
      <Card className="mt-6 p-4">
        <h2 className="text-sm font-medium text-foreground">Import into</h2>
        <div className="mt-3 flex gap-3">
          <Select value={productId} onValueChange={(v) => setProductId(v ?? "")}>
            <SelectTrigger>
              <SelectValue placeholder="Product" />
            </SelectTrigger>
            <SelectContent>
              {products.data?.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={levelId} onValueChange={(v) => setLevelId(v ?? "")}>
            <SelectTrigger>
              <SelectValue placeholder="Level" />
            </SelectTrigger>
            <SelectContent>
              {levels.data?.map((l) => (
                <SelectItem key={l.id} value={l.id}>
                  {l.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="mt-4 flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              fields.refetch();
              // Also refresh which custom fields exist - see the identical comment on
              // the test-cases import page for why.
              customFieldsQuery.refetch();
            }}
            disabled={fields.isFetching || !connection.data}
          >
            {fields.isFetching ? "Loading fields..." : "Load fields from Spira"}
          </Button>
          {fields.data && (
            <span className="text-xs text-muted-foreground">{fields.data.fields.length} fields found</span>
          )}
        </div>
        {fields.error && <p className="mt-2 text-sm text-destructive">{fields.error.message}</p>}
        {fields.data?.customFieldsWarning && (
          <p className="mt-2 text-sm text-amber-700">{fields.data.customFieldsWarning}</p>
        )}

        {fields.data && (
          <div className="mt-4 grid grid-cols-2 gap-3">
            <MappingSelect
              label="Title *"
              value={mapping.title}
              onChange={(v) => setMapping((m) => ({ ...m, title: v }))}
              fields={fields.data.fields}
              allowNone={false}
            />
            <MappingSelect
              label="Description *"
              value={mapping.description}
              onChange={(v) => setMapping((m) => ({ ...m, description: v }))}
              fields={fields.data.fields}
              allowNone={false}
            />
            <MappingSelect
              label="Background"
              value={mapping.background}
              onChange={(v) => setMapping((m) => ({ ...m, background: v }))}
              fields={fields.data.fields}
              allowNone
            />
            <MappingSelect
              label="Legacy ID (reuse as this system's id)"
              value={mapping.legacyId}
              onChange={(v) => setMapping((m) => ({ ...m, legacyId: v }))}
              fields={fields.data.fields}
              allowNone
            />
            {customFields.map((field) => (
              <MappingSelect
                key={field.id}
                label={`${field.name}${field.isRequired ? " *" : ""} (custom field)`}
                value={customFieldMapping[field.id] ?? ""}
                onChange={(v) =>
                  setCustomFieldMapping((m) => {
                    const next = { ...m };
                    if (v) next[field.id] = v;
                    else delete next[field.id];
                    return next;
                  })
                }
                fields={fields.data.fields}
                allowNone
              />
            ))}
          </div>
        )}
        {mapping.legacyId && (
          <p className="mt-2 text-xs text-muted-foreground">
            A new requirement is created using the number found in this field (e.g.
            &quot;104&quot; or &quot;SYS-104&quot; both read as 104) as its own local id
            under the level chosen below - so it shows here as e.g.{" "}
            {levels.data?.length ? `${levels.data[0]?.code ?? "SYSREQ"}-104` : "SYSREQ-104"}
            , matching Spira, instead of restarting from 1. Map &quot;Requirement ID
            (Spira&apos;s own)&quot; here to reuse Spira&apos;s built-in numbering with no
            custom field needed.{" "}
            <strong className="font-medium text-foreground">
              Works fine importing into a level that already has requirements in it
            </strong>
            : a requirement already imported before (matched by Spira&apos;s own id) is
            updated in place, not duplicated; a genuinely new one is added, claiming its
            requested number when that number is free.{" "}
            <strong className="font-medium text-foreground">
              A requested number that&apos;s already taken - by another row in this
              import, an earlier import, or something created directly here - doesn&apos;t
              block the row
            </strong>
            : it&apos;s still added, just with the next available number instead, and the
            result list below says so per row. Rows are imported in order of this number
            (not the order Spira returns them), so the whole batch is fetched before
            anything is written; the Start Row field below is ignored.
          </p>
        )}
      </Card>

      {/* --- Preview --- */}
      <Card className="mt-6 p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-foreground">Preview</h2>
          <Button
            variant="outline"
            size="sm"
            disabled={!mappingReady || preview.isPending}
            onClick={() =>
              preview.mutate({
                mapping: {
                  title: mapping.title,
                  description: mapping.description,
                  background: mapping.background || undefined,
                  legacyId: mapping.legacyId || undefined,
                  customFields: Object.keys(customFieldMapping).length ? customFieldMapping : undefined,
                },
                limit: 10,
              })
            }
          >
            {preview.isPending ? "Fetching..." : "Preview first 10"}
          </Button>
        </div>
        {!mappingReady && <p className="mt-2 text-xs text-muted-foreground">Map Title and Description first.</p>}
        {preview.error && <p className="mt-2 text-sm text-destructive">{preview.error.message}</p>}
        {preview.data && (
          <ul className="mt-3 space-y-3">
            {preview.data.map((row) => (
              <li key={row.spiraId}>
                <Card className="p-3 text-sm">
                  <p className="font-mono text-xs text-muted-foreground/70">Spira #{row.spiraId}</p>
                  <p className="font-medium">{row.title}</p>
                  <p className="text-muted-foreground">{row.description}</p>
                  {row.background && <RichTextView html={row.background} />}
                  {row.requestedSequenceNumber != null && (
                    <p className="text-xs text-muted-foreground">
                      Would try to claim local id #{row.requestedSequenceNumber}
                    </p>
                  )}
                </Card>
              </li>
            ))}
            {preview.data.length === 0 && <p className="text-sm text-muted-foreground">No requirements returned.</p>}
          </ul>
        )}
      </Card>

      {/* --- Run --- */}
      <Card className="mt-6 p-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-foreground">Run import</h2>
          <div className="flex items-center gap-2">
            <Label className="gap-1.5 text-xs text-muted-foreground">
              Start row
              <Input
                type="number"
                min={1}
                value={startRow}
                onChange={(e) => setStartRow(Math.max(1, Number(e.target.value) || 1))}
                className="h-8 w-16"
              />
            </Label>
            <Button
              disabled={!mappingReady || !productId || !levelId || runImport.isRunning}
              onClick={() =>
                runImport.run({
                  startRow,
                  unchunked: Boolean(mapping.legacyId),
                  fetchTotal: () => countRequirements.refetch().then((r) => {
                    if (r.data) return r.data.count;
                    throw new Error("count failed");
                  }),
                  fetchChunk: (chunkStartRow, maxRows) =>
                    runImportMutation.mutateAsync({
                      productId,
                      levelId,
                      mapping: {
                        title: mapping.title,
                        description: mapping.description,
                        background: mapping.background || undefined,
                        legacyId: mapping.legacyId || undefined,
                        customFields: Object.keys(customFieldMapping).length ? customFieldMapping : undefined,
                      },
                      startRow: chunkStartRow,
                      maxRows: mapping.legacyId ? undefined : maxRows,
                    }),
                })
              }
            >
              {runImport.isRunning
                ? "Importing..."
                : "Import all"}
            </Button>
          </div>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Pages through every requirement automatically, starting at the row above (leave at
          1 for a full import; only change it to resume a run that was interrupted partway).
        </p>
        {(!productId || !levelId) && <p className="mt-2 text-xs text-muted-foreground">Pick a product and level first.</p>}
        {runImport.isRunning && (
          <p className="mt-2 text-sm text-foreground">
            Importing... {runImport.processed}
            {runImport.total != null ? ` / ${runImport.total}` : ""} processed
          </p>
        )}
        {runImport.error && <p className="mt-2 text-sm text-destructive">{runImport.error}</p>}
        {runImport.hasRun && (
          <div className="mt-3">
            <p className="text-sm text-foreground">
              {actionCount(runImport.rows, "created")} created,{" "}
              {actionCount(runImport.rows, "updated")} updated,{" "}
              {actionCount(runImport.rows, "unchanged")} unchanged,{" "}
              {actionCount(runImport.rows, "skipped")} skipped,{" "}
              {runImport.rows.filter((r) => r.error).length} failed
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Re-running this import updates the same requirements instead of duplicating
              them (matched by Spira&apos;s own id) - a requirement that has moved past
              Draft is skipped, not silently rewritten.
            </p>
            <ul className="mt-2 space-y-1 text-xs">
              {runImport.rows.map((r) => (
                <li key={r.spiraId} className={r.error ? "text-destructive" : actionClassName(r.action)}>
                  <span className="font-mono">Spira #{r.spiraId}</span> - {r.title} - {resultLabel(r)}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>
      </main>
    </>
  );
}
