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
import type { TestCaseImportRowResult } from "@galm/integrations-spira";
import Link from "next/link";
import { useState } from "react";

interface TestCaseMapping {
  title: string;
  purpose: string;
  legacyId: string;
}

const EMPTY_TEST_CASE_MAPPING: TestCaseMapping = { title: "", purpose: "", legacyId: "" };

export default function SpiraImportTestCasesPage() {
  const connection = trpc.spiraImport.getConnection.useQuery();
  const testCaseFields = trpc.spiraImport.listTestCaseFields.useQuery(undefined, { enabled: false });
  const testStepFields = trpc.spiraImport.listTestStepFields.useQuery(undefined, { enabled: false });

  const products = trpc.products.list.useQuery();
  const testLevels = trpc.testCases.listLevels.useQuery();
  const customFieldsQuery = trpc.settings.listCustomFields.useQuery({ entityType: "test_case" });
  const customFields = asCustomFieldDefinitions(customFieldsQuery.data ?? []);

  const previewTestCases = trpc.spiraImport.previewTestCases.useMutation();
  const runTestCaseImportMutation = trpc.spiraImport.runTestCases.useMutation();
  const countTestCases = trpc.spiraImport.countTestCases.useQuery(undefined, { enabled: false });
  const runTestCaseImport = useChunkedSpiraImport<TestCaseImportRowResult>();
  const [unmappedRequirementIds, setUnmappedRequirementIds] = useState<number[]>([]);

  const [productId, setProductId] = useState("");
  const [testLevelId, setTestLevelId] = useState("");
  const [testType, setTestType] = useState<"verification" | "validation">("verification");
  const [testCaseMapping, setTestCaseMapping] = useState<TestCaseMapping>(EMPTY_TEST_CASE_MAPPING);
  const [testCaseStartRow, setTestCaseStartRow] = useState(1);
  const [customFieldMapping, setCustomFieldMapping] = useState<Record<string, string>>({});

  const testCaseMappingReady = testCaseMapping.title !== "";

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-3xl px-4 py-10">
      <Link href="/settings/import" className="text-sm text-muted-foreground underline underline-offset-2">
        ← Import
      </Link>
      <h1 className="mt-2 text-xl font-semibold tracking-tight">Import test cases from Spira</h1>
      <div className="mt-2">
        <ConnectionStatusNote connection={connection} />
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Only Title is a required mapping - every step&apos;s Description and Expected
        Result are always read directly from Spira, and Purpose (optional) can be mapped
        from any Test Step field, standard or custom.
      </p>

      {/* --- Target + fields + mapping --- */}
      <Card className="mt-6 p-4">
        <h2 className="text-sm font-medium text-foreground">Import into</h2>
        <div className="mt-3 flex flex-wrap gap-3">
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
          <Select value={testLevelId} onValueChange={(v) => setTestLevelId(v ?? "")}>
            <SelectTrigger>
              <SelectValue placeholder="Test level" />
            </SelectTrigger>
            <SelectContent>
              {testLevels.data?.map((l) => (
                <SelectItem key={l.id} value={l.id}>
                  {l.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={testType} onValueChange={(v) => setTestType(v as "verification" | "validation")}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="verification">Verification</SelectItem>
              <SelectItem value="validation">Validation</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Applied to every imported test case - Spira&apos;s own test case type doesn&apos;t
          map onto this fixed choice, so it isn&apos;t read from Spira.
        </p>

        <div className="mt-4 flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              testCaseFields.refetch();
              testStepFields.refetch();
              // Also refresh which custom fields exist - this page may have been open
              // (or its data cached from an earlier visit) since before a field was
              // added or removed in Settings, and that's easy to mistake for the field
              // simply not being mappable at all.
              customFieldsQuery.refetch();
            }}
            disabled={testCaseFields.isFetching || testStepFields.isFetching || !connection.data}
          >
            {testCaseFields.isFetching || testStepFields.isFetching ? "Loading fields..." : "Load fields from Spira"}
          </Button>
          {testCaseFields.data && (
            <span className="text-xs text-muted-foreground">{testCaseFields.data.fields.length} test case fields found</span>
          )}
        </div>
        {(testCaseFields.error || testStepFields.error) && (
          <p className="mt-2 text-sm text-destructive">{testCaseFields.error?.message ?? testStepFields.error?.message}</p>
        )}
        {testCaseFields.data?.customFieldsWarning && (
          <p className="mt-2 text-sm text-amber-700">{testCaseFields.data.customFieldsWarning}</p>
        )}
        {testStepFields.data?.customFieldsWarning && (
          <p className="mt-2 text-sm text-amber-700">{testStepFields.data.customFieldsWarning}</p>
        )}

        {testCaseFields.data && testStepFields.data && (
          <div className="mt-4 grid grid-cols-2 gap-3">
            <MappingSelect
              label="Title *"
              value={testCaseMapping.title}
              onChange={(v) => setTestCaseMapping((m) => ({ ...m, title: v }))}
              fields={testCaseFields.data.fields}
              allowNone={false}
            />
            <MappingSelect
              label="Step purpose (from Test Step fields)"
              value={testCaseMapping.purpose}
              onChange={(v) => setTestCaseMapping((m) => ({ ...m, purpose: v }))}
              fields={testStepFields.data.fields}
              allowNone
            />
            <MappingSelect
              label="Legacy ID (reuse as this system's id)"
              value={testCaseMapping.legacyId}
              onChange={(v) => setTestCaseMapping((m) => ({ ...m, legacyId: v }))}
              fields={testCaseFields.data.fields}
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
                fields={testCaseFields.data.fields}
                allowNone
              />
            ))}
          </div>
        )}
        {testCaseMapping.legacyId && (
          <p className="mt-2 text-xs text-muted-foreground">
            A new test case is created using the number found in this field as its own
            local id, matching Spira, instead of restarting from 1. Map &quot;Test Case ID
            (Spira&apos;s own)&quot; here to reuse Spira&apos;s built-in numbering with no
            custom field needed.{" "}
            <strong className="font-medium text-foreground">
              Works fine importing into a test level that already has test cases in it
            </strong>
            : a test case already imported before (matched by Spira&apos;s own id) is
            updated in place, not duplicated; a genuinely new one is added, claiming its
            requested number when that number is free.{" "}
            <strong className="font-medium text-foreground">
              A requested number that&apos;s already taken - by another row in this
              import, an earlier import, or something created directly here - doesn&apos;t
              block the row
            </strong>
            : it&apos;s still added, just with the next available number instead, and the
            result list below says so per row. Rows are imported in order of this number,
            so the whole batch is fetched before anything is written; the Start Row field
            below is ignored.
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
            disabled={!testCaseMappingReady || previewTestCases.isPending}
            onClick={() =>
              previewTestCases.mutate({
                mapping: {
                  title: testCaseMapping.title,
                  purpose: testCaseMapping.purpose || undefined,
                  legacyId: testCaseMapping.legacyId || undefined,
                  customFields: Object.keys(customFieldMapping).length ? customFieldMapping : undefined,
                },
                limit: 5,
              })
            }
          >
            {previewTestCases.isPending ? "Fetching..." : "Preview first 5"}
          </Button>
        </div>
        {!testCaseMappingReady && <p className="mt-2 text-xs text-muted-foreground">Map Title first.</p>}
        {previewTestCases.error && <p className="mt-2 text-sm text-destructive">{previewTestCases.error.message}</p>}
        {previewTestCases.data && (
          <ul className="mt-3 space-y-3">
            {previewTestCases.data.map((tc) => (
              <li key={tc.spiraId}>
                <Card className="p-3 text-sm">
                  <p className="font-mono text-xs text-muted-foreground/70">
                    Spira #{tc.spiraId} {tc.spiraTestCaseType && `- ${tc.spiraTestCaseType}`}
                  </p>
                  <p className="font-medium">{tc.title}</p>
                  {tc.requestedSequenceNumber != null && (
                    <p className="text-xs text-muted-foreground">
                      Would try to claim local id #{tc.requestedSequenceNumber}
                    </p>
                  )}
                  <ol className="mt-2 list-decimal space-y-2 pl-4">
                    {tc.steps.map((step) => (
                      <li key={step.spiraStepId}>
                        <RichTextView html={step.description} />
                        <div className="mt-1 text-xs text-muted-foreground">
                          <span className="mr-1">Expected:</span>
                          <RichTextView html={step.expectedResult} />
                        </div>
                        {step.purpose && <p className="mt-1 text-xs text-muted-foreground/70">Purpose: {step.purpose}</p>}
                      </li>
                    ))}
                    {tc.steps.length === 0 && <p className="text-xs text-destructive">No steps - would be skipped.</p>}
                  </ol>
                </Card>
              </li>
            ))}
            {previewTestCases.data.length === 0 && <p className="text-sm text-muted-foreground">No test cases returned.</p>}
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
                value={testCaseStartRow}
                onChange={(e) => setTestCaseStartRow(Math.max(1, Number(e.target.value) || 1))}
                className="h-8 w-16"
              />
            </Label>
            <Button
              disabled={!testCaseMappingReady || !productId || !testLevelId || runTestCaseImport.isRunning}
              onClick={() => {
                setUnmappedRequirementIds([]);
                runTestCaseImport.run({
                  startRow: testCaseStartRow,
                  unchunked: Boolean(testCaseMapping.legacyId),
                  fetchTotal: () =>
                    countTestCases.refetch().then((r) => {
                      if (r.data) return r.data.count;
                      throw new Error("count failed");
                    }),
                  fetchChunk: async (chunkStartRow, maxRows) => {
                    const result = await runTestCaseImportMutation.mutateAsync({
                      productId,
                      levelId: testLevelId,
                      testType,
                      mapping: {
                        title: testCaseMapping.title,
                        purpose: testCaseMapping.purpose || undefined,
                        legacyId: testCaseMapping.legacyId || undefined,
                        customFields: Object.keys(customFieldMapping).length ? customFieldMapping : undefined,
                      },
                      startRow: chunkStartRow,
                      maxRows: testCaseMapping.legacyId ? undefined : maxRows,
                    });
                    if (result.unmappedRequirementIds.length > 0) {
                      setUnmappedRequirementIds((prev) => [...new Set([...prev, ...result.unmappedRequirementIds])].sort((a, b) => a - b));
                    }
                    return result.rows;
                  },
                });
              }}
            >
              {runTestCaseImport.isRunning
                ? "Importing..."
                : "Import all"}
            </Button>
          </div>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Pages through every test case (and its steps) automatically, starting at the row
          above (leave at 1 for a full import; only change it to resume a run that was
          interrupted partway). A Spira test case with zero steps is skipped, not failed -
          our model requires at least one step. Each test case&apos;s own requirement trace
          links (in Spira) are imported too, matched against requirements already imported
          here - assumed to already exist, never created by this screen.
        </p>
        {(!productId || !testLevelId) && (
          <p className="mt-2 text-xs text-muted-foreground">Pick a product and test level first.</p>
        )}
        {runTestCaseImport.isRunning && (
          <p className="mt-2 text-sm text-foreground">
            Importing... {runTestCaseImport.processed}
            {runTestCaseImport.total != null ? ` / ${runTestCaseImport.total}` : ""} processed
          </p>
        )}
        {runTestCaseImport.error && <p className="mt-2 text-sm text-destructive">{runTestCaseImport.error}</p>}
        {unmappedRequirementIds.length > 0 && (
          <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3">
            <p className="text-sm font-medium text-amber-900">
              {unmappedRequirementIds.length} requirement(s) linked in Spira weren&apos;t found here
            </p>
            <p className="mt-1 text-xs text-amber-800">
              These test cases reference Spira requirements that haven&apos;t been imported
              into this product/level yet - import requirements first, then re-run this
              import to pick up the links (matched by Spira&apos;s own id, added without
              touching anything else already imported).
            </p>
            <p className="mt-2 font-mono text-xs text-amber-900">
              {unmappedRequirementIds.map((id) => `#${id}`).join(", ")}
            </p>
          </div>
        )}
        {runTestCaseImport.hasRun && (
          <div className="mt-3">
            <p className="text-sm text-foreground">
              {actionCount(runTestCaseImport.rows, "created")} created,{" "}
              {actionCount(runTestCaseImport.rows, "updated")} updated,{" "}
              {actionCount(runTestCaseImport.rows, "unchanged")} unchanged,{" "}
              {runTestCaseImport.rows.filter((r) => r.error).length} failed/skipped
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Re-running this import updates the same test case&apos;s steps in place
              instead of duplicating them (matched by Spira&apos;s own id) - a step removed
              at the source is left alone locally, not deleted. Requirement trace links are
              only ever added, never removed, on re-import.
            </p>
            <ul className="mt-2 space-y-1 text-xs">
              {runTestCaseImport.rows.map((r) => (
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
