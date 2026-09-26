"use client";

import { ProductContextStrip } from "@/components/context-strip";
import {
  asCustomFieldDefinitions,
  type CustomFieldFormState,
  CustomFieldInputs,
  toCustomFieldValuesInput,
} from "@/components/custom-fields";
import { AiStepAssistBody } from "@/components/ai-tools-panel";
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
      <ProductContextStrip productId={productId} entry="testCases" activeLevelId={levelId || null} />

      <div className="flex items-stretch">
        <form
          className="min-w-0 flex-1 space-y-5 p-5 pb-8"
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
          <p className="font-heading text-[30px] leading-tight tracking-tight">New test case</p>

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

          <CustomFieldInputs
            fields={customFields}
            state={customFieldState}
            onChange={(fieldId, value) => setCustomFieldState((s) => ({ ...s, [fieldId]: value }))}
          />

          <Label className="flex-col items-start gap-1">
            <span className="text-sm font-medium text-muted-foreground">
              Linked requirements (optional, applies to the whole test case)
            </span>
            <RequirementPicker options={requirementOptions.data ?? []} value={requirementIds} onChange={setRequirementIds} />
          </Label>

          <div>
            <h5 className="mb-2 font-heading text-[13px] tracking-[0.14em] text-muted-foreground uppercase">Steps</h5>
            <TestStepsEditor steps={steps} onChange={setSteps} requirementOptions={requirementOptions.data ?? []} />
          </div>

          {createTestCase.error && <p className="text-sm text-destructive">{createTestCase.error.message}</p>}

          <Button type="submit" disabled={createTestCase.isPending || !levelId}>
            {createTestCase.isPending ? "Creating..." : "Create test case"}
          </Button>
        </form>

        {/* AI-only rail - no Run/History tabs yet, since there's no persisted test case
            (and so no execution history) until this form is first submitted. */}
        <aside className="w-[352px] flex-none border-l border-border p-5">
          <p className="mb-2 border border-border bg-card py-1 text-center font-heading text-[12.5px] tracking-[0.1em] text-muted-foreground uppercase">
            AI
          </p>
          <AiStepAssistBody
            productId={productId}
            testCaseTitle={title}
            steps={steps}
            onAccept={setSteps}
            requirementOptions={requirementOptions.data ?? []}
          />
        </aside>
      </div>
    </>
  );
}
