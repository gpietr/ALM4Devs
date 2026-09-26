"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc-client";
import { useState } from "react";

// Standalone copy of @galm/core's OTS_VERSION_SUPPORT_STATUSES (client component).
const SUPPORT_STATUSES = [
  { value: "in_use", label: "In use" },
  { value: "allowed", label: "Allowed" },
  { value: "retired", label: "Retired" },
] as const;

const NO_TEST_SET = "none";

type AssessmentKey =
  | "verificationSummary"
  | "regressionAnalysis"
  | "safetyImpact"
  | "designImpact"
  | "installationImpact"
  | "obsolescenceImpact";

/** Change-impact questions for a new or changed OTS version (FDA OTS guidance Appendix A). */
const ASSESSMENT_FIELDS: Array<{ key: AssessmentKey; label: string }> = [
  { key: "verificationSummary", label: "Testing / validation of this version with the product" },
  { key: "regressionAnalysis", label: "Regression analysis - what could this change affect, and which tests were rerun?" },
  { key: "safetyImpact", label: "Safety - are safety functions isolated from it; does it affect system safety integrity?" },
  { key: "designImpact", label: "Design - performance, operational environment, data integrity" },
  { key: "installationImpact", label: "Installation - impact on installations already in the field" },
  { key: "obsolescenceImpact", label: "Obsolescence - does it replace a fielded component; is the old one still available?" },
];

type Draft = Record<AssessmentKey, string> & { regressionTestPerformed: boolean; testSetId: string };

/** Per-version support status ("allowed" = validated for use) and change-impact assessment. */
export function OtsVersionControls({
  nodeId,
  productId,
  versionId,
  supportStatus,
}: {
  nodeId: string;
  productId: string;
  versionId: string;
  supportStatus: string;
}) {
  const utils = trpc.useUtils();
  const doc = trpc.ots.documentation.useQuery({ nodeId });
  const testSets = trpc.testSets.listByProduct.useQuery({ productId });
  const invalidate = () =>
    Promise.all([
      utils.ots.documentation.invalidate({ nodeId }),
      utils.ots.register.invalidate(),
      utils.architecture.get.invalidate({ id: nodeId }),
    ]);
  const setStatus = trpc.ots.setVersionStatus.useMutation({ onSuccess: invalidate });
  const saveAssessment = trpc.ots.saveVersionAssessment.useMutation({ onSuccess: invalidate });
  const [draft, setDraft] = useState<Draft | null>(null);

  const assessment = doc.data?.versions.find((v) => v.id === versionId)?.assessment ?? null;

  function openEditor() {
    const next = {
      regressionTestPerformed: assessment?.regressionTestPerformed ?? false,
      testSetId: assessment?.testSetId ?? NO_TEST_SET,
    } as Draft;
    for (const f of ASSESSMENT_FIELDS) next[f.key] = assessment?.[f.key] ?? "";
    saveAssessment.reset();
    setDraft(next);
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={supportStatus} onValueChange={(v) => v && setStatus.mutate({ nodeId, versionId, supportStatus: v as (typeof SUPPORT_STATUSES)[number]["value"] })}>
          <SelectTrigger size="sm" className="h-7 w-28 text-[12px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SUPPORT_STATUSES.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {assessment ? (
          <Badge variant="outline">assessed {new Date(assessment.assessedAt).toLocaleDateString()}</Badge>
        ) : (
          supportStatus === "allowed" && <Badge variant="destructive">not assessed</Badge>
        )}
        {!draft && (
          <Button type="button" size="sm" variant="ghost" className="h-7 text-[12px]" onClick={openEditor}>
            {assessment ? "Edit assessment" : "Assess change"}
          </Button>
        )}
      </div>
      {setStatus.error && <p className="text-sm text-destructive">{setStatus.error.message}</p>}

      {draft && (
        // A div, not a <form> - this sits inside the detail page's own <form>.
        <div className="space-y-2.5 border border-border bg-background p-3">
          <p className="text-[11.5px] text-muted-foreground">
            Change-impact assessment
          </p>
          {ASSESSMENT_FIELDS.map((f) => (
            <Label key={f.key} className="flex-col items-start gap-1">
              <span className="text-[12px]">{f.label}</span>
              <Textarea rows={2} value={draft[f.key]} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} />
            </Label>
          ))}
          <div className="flex flex-wrap items-center gap-4">
            <Label className="gap-1.5">
              <Checkbox
                checked={draft.regressionTestPerformed}
                onCheckedChange={(checked) => setDraft({ ...draft, regressionTestPerformed: checked })}
              />
              <span className="text-[12.5px]">System regression test performed</span>
            </Label>
            <Label className="items-center gap-2">
              <span className="text-[12.5px]">Test set</span>
              <Select value={draft.testSetId} onValueChange={(v) => v && setDraft({ ...draft, testSetId: v })}>
                <SelectTrigger size="sm" className="h-7 w-52 text-[12px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_TEST_SET}>None</SelectItem>
                  {(testSets.data ?? []).map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Label>
          </div>
          {saveAssessment.error && <p className="text-sm text-destructive">{saveAssessment.error.message}</p>}
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              disabled={saveAssessment.isPending}
              onClick={() =>
                saveAssessment.mutate(
                  {
                    nodeId,
                    versionId,
                    fields: {
                      ...Object.fromEntries(ASSESSMENT_FIELDS.map((f) => [f.key, draft[f.key] || null])),
                      regressionTestPerformed: draft.regressionTestPerformed,
                      testSetId: draft.testSetId === NO_TEST_SET ? null : draft.testSetId,
                    },
                  },
                  { onSuccess: () => setDraft(null) },
                )
              }
            >
              {saveAssessment.isPending ? "Saving…" : "Save assessment"}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setDraft(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
