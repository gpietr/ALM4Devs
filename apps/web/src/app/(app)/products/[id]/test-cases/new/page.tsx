"use client";

import { ProductContextStrip } from "@/components/context-strip";
import {
  asCustomFieldDefinitions,
  type CustomFieldFormState,
  CustomFieldInputs,
  toCustomFieldValuesInput,
} from "@/components/custom-fields";
import { AiToolsPanel } from "@/components/ai-tools-panel";
import { RequirementPicker } from "@/components/requirement-picker";
import { emptyStep, TestStepsEditor } from "@/components/test-steps-editor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { trpc } from "@/lib/trpc-client";
import { useRouter, useSearchParams } from "next/navigation";
import { use, useState } from "react";

export default function NewTestCasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id: productId } = use(params);
  const searchParams = useSearchParams();
  const router = useRouter();
  const initialLevelId = searchParams.get("levelId") ?? "";

  const levels = trpc.testCases.listLevels.useQuery();
  const requirementOptions = trpc.requirements.listAllByProduct.useQuery({ productId });
  const customFieldsQuery = trpc.settings.listCustomFields.useQuery({ entityType: "test_case" });
  const customFields = asCustomFieldDefinitions(customFieldsQuery.data ?? []);
  const createTestCase = trpc.testCases.create.useMutation();

  const [levelId, setLevelId] = useState(initialLevelId);
  const [title, setTitle] = useState("");
  const [requirementIds, setRequirementIds] = useState<string[]>([]);
  const [steps, setSteps] = useState([emptyStep()]);
  const [customFieldState, setCustomFieldState] = useState<CustomFieldFormState>({});

  return (
    <>
      <ProductContextStrip productId={productId} artifact="testCases" activeLevelId={levelId || null} />
      <main className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-xl font-semibold tracking-tight">New test case</h1>

      <form
        className="mt-6 space-y-6"
        onSubmit={(e) => {
          e.preventDefault();
          createTestCase.mutate(
            {
              productId,
              levelId,
              title,
              requirementIds: requirementIds.length ? requirementIds : undefined,
              steps: steps.map((s) => ({
                description: s.description,
                expectedResult: s.expectedResult,
                purpose: s.purpose || undefined,
                requirementIds: s.requirementIds.length ? s.requirementIds : undefined,
              })),
              customFieldValues: toCustomFieldValuesInput(customFieldState),
            },
            {
              onSuccess: (result) => router.push(`/test-cases/${result.testCase.id}`),
            },
          );
        }}
      >
        <div className="flex gap-3">
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

        <Input required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" />

        <Label className="flex-col items-start gap-1">
          <span className="text-sm font-medium text-muted-foreground">
            Linked requirements (optional, applies to the whole test case)
          </span>
          <RequirementPicker
            options={requirementOptions.data ?? []}
            value={requirementIds}
            onChange={setRequirementIds}
          />
        </Label>

        <div className="space-y-3">
          <h2 className="text-sm font-medium text-foreground">Steps</h2>
          <TestStepsEditor steps={steps} onChange={setSteps} requirementOptions={requirementOptions.data ?? []} />
        </div>

        <CustomFieldInputs
          fields={customFields}
          state={customFieldState}
          onChange={(fieldId, value) => setCustomFieldState((s) => ({ ...s, [fieldId]: value }))}
        />

        {createTestCase.error && <p className="text-sm text-destructive">{createTestCase.error.message}</p>}

        <Button type="submit" disabled={createTestCase.isPending || !levelId}>
          {createTestCase.isPending ? "Creating..." : "Create test case"}
        </Button>
      </form>
      </main>

      <AiToolsPanel
        productId={productId}
        testCaseTitle={title}
        steps={steps}
        onAccept={setSteps}
        requirementOptions={requirementOptions.data ?? []}
      />
    </>
  );
}
