"use client";

import { Frame } from "@/components/frame";
import { RequirementPicker } from "@/components/requirement-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc-client";
import { Pencil, Trash2 } from "lucide-react";
import { useState } from "react";

// Standalone copy - @galm/core's barrel pulls in the database layer.
const OUTCOMES = [
  { value: "not_applicable", label: "Not applicable" },
  { value: "acceptable", label: "Acceptable" },
  { value: "mitigated", label: "Mitigated" },
  { value: "not_acceptable", label: "Not acceptable" },
] as const;
const OUTCOME_LABEL: Record<string, string> = Object.fromEntries(OUTCOMES.map((o) => [o.value, o.label]));
const OUTCOME_VARIANT: Record<string, "destructive" | "outline" | "secondary"> = {
  not_acceptable: "destructive",
  mitigated: "outline",
  acceptable: "secondary",
  not_applicable: "secondary",
};

const NOT_ASSESSED = "none";

interface Draft {
  externalId: string;
  title: string;
  description: string;
  sourceUrl: string;
  discoveryMethod: string;
  rootCause: string;
  impactEvaluation: string;
  outcome: string;
  rationale: string;
  defectClassification: string;
  mitigation: string;
  endUserCommunication: string;
  resolvedInVersion: string;
  affectedVersionIds: string[];
  requirementIds: string[];
}

const EMPTY_DRAFT: Draft = {
  externalId: "",
  title: "",
  description: "",
  sourceUrl: "",
  discoveryMethod: "",
  rootCause: "",
  impactEvaluation: "",
  outcome: NOT_ASSESSED,
  rationale: "",
  defectClassification: "",
  mitigation: "",
  endUserCommunication: "",
  resolvedInVersion: "",
  affectedVersionIds: [],
  requirementIds: [],
};

/** Known issues (vendor bugs), entered by hand - unlike CVEs, which come from NVD. */
export function OtsAnomaliesSection({ nodeId, productId }: { nodeId: string; productId: string }) {
  const utils = trpc.useUtils();
  const doc = trpc.ots.documentation.useQuery({ nodeId });
  const requirementOptions = trpc.requirements.listAllByProduct.useQuery({ productId });
  const invalidate = () => Promise.all([utils.ots.documentation.invalidate({ nodeId }), utils.ots.register.invalidate()]);
  const createAnomaly = trpc.ots.createAnomaly.useMutation({ onSuccess: invalidate });
  const updateAnomaly = trpc.ots.updateAnomaly.useMutation({ onSuccess: invalidate });
  const deleteAnomaly = trpc.ots.deleteAnomaly.useMutation({ onSuccess: invalidate });
  const markReviewed = trpc.ots.markAnomaliesReviewed.useMutation({ onSuccess: invalidate });

  const [editing, setEditing] = useState<{ id: string | null } | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);

  if (doc.error) return <p className="p-6 text-sm text-destructive">{doc.error.message}</p>;
  if (!doc.data) return <p className="p-6 text-sm text-muted-foreground">Loading...</p>;

  const { anomalies, versions, profile, anomaliesReviewedByName } = doc.data;
  const versionLabel = new Map(versions.map((v) => [v.id, v.version]));
  const update = (patch: Partial<Draft>) => setDraft((prev) => ({ ...prev, ...patch }));
  const needsRationale = draft.outcome !== NOT_ASSESSED;
  const saveMutation = editing?.id ? updateAnomaly : createAnomaly;

  function openCreate() {
    setDraft(EMPTY_DRAFT);
    createAnomaly.reset();
    setEditing({ id: null });
  }

  function openEdit(anomaly: (typeof anomalies)[number]) {
    setDraft({
      externalId: anomaly.externalId ?? "",
      title: anomaly.title,
      description: anomaly.description,
      sourceUrl: anomaly.sourceUrl ?? "",
      discoveryMethod: anomaly.discoveryMethod ?? "",
      rootCause: anomaly.rootCause ?? "",
      impactEvaluation: anomaly.impactEvaluation ?? "",
      outcome: anomaly.outcome ?? NOT_ASSESSED,
      rationale: anomaly.rationale ?? "",
      defectClassification: anomaly.defectClassification ?? "",
      mitigation: anomaly.mitigation ?? "",
      endUserCommunication: anomaly.endUserCommunication ?? "",
      resolvedInVersion: anomaly.resolvedInVersion ?? "",
      affectedVersionIds: anomaly.affectedVersionIds,
      requirementIds: anomaly.requirements.map((r) => r.id),
    });
    updateAnomaly.reset();
    setEditing({ id: anomaly.id });
  }

  async function save() {
    const payload = {
      externalId: draft.externalId || null,
      title: draft.title,
      description: draft.description,
      sourceUrl: draft.sourceUrl || null,
      discoveryMethod: draft.discoveryMethod || null,
      rootCause: draft.rootCause || null,
      impactEvaluation: draft.impactEvaluation || null,
      outcome: draft.outcome === NOT_ASSESSED ? null : (draft.outcome as (typeof OUTCOMES)[number]["value"]),
      rationale: draft.rationale || null,
      defectClassification: draft.defectClassification || null,
      mitigation: draft.mitigation || null,
      endUserCommunication: draft.endUserCommunication || null,
      resolvedInVersion: draft.resolvedInVersion || null,
      affectedVersionIds: draft.affectedVersionIds,
      requirementIds: draft.requirementIds,
    };
    if (editing?.id) await updateAnomaly.mutateAsync({ anomalyId: editing.id, anomaly: payload });
    else await createAnomaly.mutateAsync({ nodeId, anomaly: payload });
    setEditing(null);
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-5 pb-24">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <p className="text-[12.5px] text-muted-foreground">
            Known bugs in this OTS software, from the vendor&rsquo;s release notes or bug tracker
            {profile.anomalyListUrl && (
              <>
                {" "}
                (
                <a href={profile.anomalyListUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                  vendor list
                </a>
                )
              </>
            )}
            . Evaluate each one&rsquo;s impact on the product.
          </p>
          <p className="mt-1 text-[12px] text-muted-foreground">
            {profile.anomaliesReviewedAt
              ? `List last reviewed ${new Date(profile.anomaliesReviewedAt).toLocaleDateString()}${anomaliesReviewedByName ? ` by ${anomaliesReviewedByName}` : ""}.`
              : "List never marked as reviewed."}
          </p>
        </div>
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="outline" disabled={markReviewed.isPending} onClick={() => markReviewed.mutate({ nodeId })}>
            {markReviewed.isPending ? "Saving…" : "Mark list reviewed"}
          </Button>
          <Button type="button" size="sm" onClick={openCreate}>
            Add issue
          </Button>
        </div>
      </div>
      {markReviewed.error && <p className="text-sm text-destructive">{markReviewed.error.message}</p>}
      {deleteAnomaly.error && <p className="text-sm text-destructive">{deleteAnomaly.error.message}</p>}

      <Frame className="bg-card">
        {anomalies.length === 0 ? (
          <p className="px-4 py-6 text-[13.5px] text-muted-foreground">No known issues recorded.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Issue</TableHead>
                <TableHead>Affected versions</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead>Risk controls</TableHead>
                <TableHead className="w-[80px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {anomalies.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="max-w-[360px]">
                    <div className="text-[13px]">
                      {a.externalId && <span className="mr-1.5 font-mono text-[11.5px] text-muted-foreground">{a.externalId}</span>}
                      {a.sourceUrl ? (
                        <a href={a.sourceUrl} target="_blank" rel="noreferrer" className="hover:underline">
                          {a.title}
                        </a>
                      ) : (
                        a.title
                      )}
                    </div>
                    {a.impactEvaluation && <p className="mt-0.5 line-clamp-2 text-[12px] text-muted-foreground">{a.impactEvaluation}</p>}
                  </TableCell>
                  <TableCell className="text-[12.5px] text-muted-foreground">
                    {a.affectedVersionIds.length > 0 ? a.affectedVersionIds.map((id) => versionLabel.get(id)).join(", ") : "All"}
                    {a.resolvedInVersion && <div>fixed in {a.resolvedInVersion}</div>}
                  </TableCell>
                  <TableCell>
                    {a.outcome ? (
                      <Badge variant={OUTCOME_VARIANT[a.outcome] ?? "outline"}>{OUTCOME_LABEL[a.outcome] ?? a.outcome}</Badge>
                    ) : (
                      <Badge variant="destructive">Not assessed</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-[12px] text-muted-foreground">
                    {a.requirements.length > 0 ? a.requirements.map((r) => r.displayId).join(", ") : "—"}
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button type="button" size="icon-sm" variant="ghost" onClick={() => openEdit(a)}>
                        <Pencil size={14} />
                      </Button>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        disabled={deleteAnomaly.isPending}
                        onClick={() => {
                          if (confirm(`Delete issue "${a.title}"?`)) deleteAnomaly.mutate({ anomalyId: a.id });
                        }}
                      >
                        <Trash2 size={14} />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Frame>

      <Dialog open={!!editing} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing?.id ? "Edit issue" : "Add issue"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
              <Label className="flex-col items-start gap-1">
                <span className="text-[12px]">Vendor ID</span>
                <Input value={draft.externalId} onChange={(e) => update({ externalId: e.target.value })} placeholder="e.g. #1234" />
              </Label>
              <Label className="flex-col items-start gap-1">
                <span className="text-[12px]">Title</span>
                <Input required value={draft.title} onChange={(e) => update({ title: e.target.value })} />
              </Label>
            </div>
            <Label className="flex-col items-start gap-1">
              <span className="text-[12px]">Description</span>
              <Textarea rows={2} value={draft.description} onChange={(e) => update({ description: e.target.value })} />
            </Label>
            <Label className="flex-col items-start gap-1">
              <span className="text-[12px]">Source URL</span>
              <Input value={draft.sourceUrl} onChange={(e) => update({ sourceUrl: e.target.value })} placeholder="https://…" />
            </Label>

            {versions.length > 0 && (
              <div className="space-y-1.5">
                <span className="text-[12px] font-medium">Affected versions</span>
                <p className="text-[11.5px] text-muted-foreground">None ticked = all versions.</p>
                <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                  {versions.map((v) => (
                    <Label key={v.id} className="gap-1.5">
                      <Checkbox
                        checked={draft.affectedVersionIds.includes(v.id)}
                        onCheckedChange={(checked) =>
                          update({
                            affectedVersionIds: checked
                              ? [...draft.affectedVersionIds, v.id]
                              : draft.affectedVersionIds.filter((id) => id !== v.id),
                          })
                        }
                      />
                      <span className="text-[12.5px]">{v.version}</span>
                    </Label>
                  ))}
                </div>
              </div>
            )}
            <Label className="flex-col items-start gap-1">
              <span className="text-[12px]">Fixed in version</span>
              <Input
                className="w-56"
                value={draft.resolvedInVersion}
                onChange={(e) => update({ resolvedInVersion: e.target.value })}
                placeholder="e.g. 2.4.1"
              />
            </Label>

            <div className="space-y-3 border-t border-border pt-3">
              <p className="text-[11.5px] text-muted-foreground">
                Evaluation
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <Label className="flex-col items-start gap-1">
                  <span className="text-[12px]">How it was discovered</span>
                  <Textarea rows={2} value={draft.discoveryMethod} onChange={(e) => update({ discoveryMethod: e.target.value })} />
                </Label>
                <Label className="flex-col items-start gap-1">
                  <span className="text-[12px]">Root cause (where known)</span>
                  <Textarea rows={2} value={draft.rootCause} onChange={(e) => update({ rootCause: e.target.value })} />
                </Label>
              </div>
              <Label className="flex-col items-start gap-1">
                <span className="text-[12px]">Impact on safety and effectiveness (incl. operator usage and human factors)</span>
                <Textarea rows={3} value={draft.impactEvaluation} onChange={(e) => update({ impactEvaluation: e.target.value })} />
              </Label>
              <div className="grid gap-3 sm:grid-cols-2">
                <Label className="flex-col items-start gap-1">
                  <span className="text-[12px]">Outcome of the evaluation</span>
                  <Select value={draft.outcome} onValueChange={(v) => v && update({ outcome: v })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NOT_ASSESSED}>Not assessed yet</SelectItem>
                      {OUTCOMES.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Label>
                <Label className="flex-col items-start gap-1">
                  <span className="text-[12px]">Defect classification</span>
                  <Input value={draft.defectClassification} onChange={(e) => update({ defectClassification: e.target.value })} />
                </Label>
              </div>
              <Label className="flex-col items-start gap-1">
                <span className="text-[12px]">Risk-based rationale{needsRationale ? " (required with an outcome)" : ""}</span>
                <Textarea rows={3} value={draft.rationale} onChange={(e) => update({ rationale: e.target.value })} />
              </Label>
              <Label className="flex-col items-start gap-1">
                <span className="text-[12px]">Mitigation</span>
                <Textarea rows={2} value={draft.mitigation} onChange={(e) => update({ mitigation: e.target.value })} />
              </Label>
              <Label className="flex-col items-start gap-1">
                <span className="text-[12px]">Communicated to end users (work-arounds, documentation)</span>
                <Textarea rows={2} value={draft.endUserCommunication} onChange={(e) => update({ endUserCommunication: e.target.value })} />
              </Label>
              <Label className="flex-col items-start gap-1">
                <span className="text-[12px]">Risk-control requirements</span>
                <RequirementPicker
                  options={requirementOptions.data ?? []}
                  value={draft.requirementIds}
                  onChange={(ids) => update({ requirementIds: ids })}
                />
              </Label>
            </div>
            {saveMutation.error && <p className="text-sm text-destructive">{saveMutation.error.message}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={saveMutation.isPending || !draft.title.trim() || (needsRationale && !draft.rationale.trim())}
              onClick={() => void save().catch(() => {})}
            >
              {saveMutation.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
