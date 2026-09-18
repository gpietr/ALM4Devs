"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Frame } from "@/components/frame";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { trpc } from "@/lib/trpc-client";
import { cn } from "cn";
import { CheckCircle2, Pencil, StickyNote } from "lucide-react";
import { useMemo, useState, memo } from "react";

const SEVERITY_VARIANT: Record<string, "destructive" | "outline" | "secondary"> = {
  CRITICAL: "destructive",
  HIGH: "destructive",
  MEDIUM: "outline",
  LOW: "secondary",
};

interface Finding {
  cveId: string;
  description: string | null;
  cvssScore: number | null;
  severity: string | null;
  sourceUrl: string | null;
  isNew: boolean;
  assessed: boolean;
  affectsProduct: boolean;
  falsePositive: boolean;
  rationale: string | null;
  notes: string | null;
  confirmedUnderCurrentVersion: boolean;
}

interface Draft {
  assessed: boolean;
  affectsProduct: boolean;
  falsePositive: boolean;
  rationale: string;
  notes: string;
}

function draftOf(finding: Finding): Draft {
  return {
    assessed: finding.assessed,
    affectsProduct: finding.affectsProduct,
    falsePositive: finding.falsePositive,
    rationale: finding.rationale ?? "",
    notes: finding.notes ?? "",
  };
}

// "CVE-YYYY-NNNN" isn't a plain number, so a lexicographic sort would put CVE-2024-10000
// before CVE-2024-9999 - parse the year and sequence out and compare both numerically.
function parseCveId(cveId: string): [number, number] {
  const m = /^CVE-(\d{4})-(\d+)$/.exec(cveId);
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
}

function outcome(finding: Finding): { label: string; variant: "outline" | "secondary" | "destructive" } {
  if (finding.isNew) return { label: "Unreviewed", variant: "outline" };
  if (finding.falsePositive) return { label: "False positive", variant: "secondary" };
  if (!finding.affectsProduct) return { label: "Not applicable", variant: "secondary" };
  return { label: "Confirmed", variant: "destructive" };
}

export function VulnerabilitiesSection({ nodeId }: { nodeId: string }) {
  const utils = trpc.useUtils();
  const list = trpc.vulnerabilities.listForNode.useQuery({ nodeId });
  const scanNode = trpc.vulnerabilities.scanNode.useMutation({
    onSuccess: () => utils.vulnerabilities.listForNode.invalidate({ nodeId }),
  });

  // Sorted purely by CVE number (newest first) - fixed, so a row never jumps to a new
  // position just because the user assessed it (the old sort put unreviewed/stale
  // findings first, which reshuffled the list out from under whoever was editing it).
  const sorted = useMemo(() => {
    if (!list.data) return [];
    return [...list.data.findings].sort((a, b) => {
      const [ay, an] = parseCveId(a.cveId);
      const [by, bn] = parseCveId(b.cveId);
      return ay !== by ? by - ay : bn - an;
    });
  }, [list.data]);

  if (list.isLoading) {
    return <p className="mt-8 text-[13.5px] text-muted-foreground">Loading vulnerabilities...</p>;
  }
  if (list.error) {
    return <p className="mt-8 text-sm text-destructive">{list.error.message}</p>;
  }
  if (!list.data) return null;

  const { latestScan } = list.data;

  return (
    <div className="mx-auto max-w-5xl p-5">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <p className="font-mono text-[10.5px] tracking-[0.1em] text-muted-foreground uppercase">Vulnerabilities</p>
          <p className="mt-1 text-[12.5px] text-muted-foreground">
            {latestScan
              ? latestScan.status === "failed"
                ? `Last scan failed: ${latestScan.errorMessage}`
                : `Last scanned ${new Date(latestScan.createdAt).toLocaleString()} (${latestScan.matchType === "cpe" ? "exact CPE match" : `keyword: "${latestScan.query}"`})`
              : "Never scanned."}
          </p>
        </div>
        <Button type="button" size="sm" disabled={scanNode.isPending} onClick={() => scanNode.mutate({ nodeId })}>
          {scanNode.isPending ? "Scanning…" : "Scan now"}
        </Button>
      </div>
      {scanNode.error && <p className="mb-2 text-sm text-destructive">{scanNode.error.message}</p>}

      {sorted.length === 0 ? (
        <p className="py-6 text-[13.5px] text-muted-foreground">
          No vulnerabilities reported{latestScan ? "" : " yet - run a scan"}.
        </p>
      ) : (
        <Frame className="bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[120px]">CVE</TableHead>
                <TableHead className="w-[100px]">Severity</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="w-[130px]">Status</TableHead>
                <TableHead className="w-[60px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((finding) => (
                <FindingRow key={finding.cveId} nodeId={nodeId} finding={finding} />
              ))}
            </TableBody>
          </Table>
        </Frame>
      )}
    </div>
  );
}

/** Each row owns its own draft/annotate state, instead of the whole table sharing one
 * `drafts` map - with 200+ findings, a shared map meant every keystroke or toggle
 * re-rendered and re-sorted the entire list, which is what made editing unusable. */
const FindingRow = memo(function FindingRow({ nodeId, finding }: { nodeId: string; finding: Finding }) {
  const utils = trpc.useUtils();
  const [editOpen, setEditOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => draftOf(finding));
  const annotate = trpc.vulnerabilities.annotate.useMutation({
    onSuccess: () => {
      utils.vulnerabilities.listForNode.invalidate({ nodeId });
      setEditOpen(false);
    },
  });

  const needsRationale = !draft.affectsProduct || draft.falsePositive;
  const hasNote = !!finding.rationale || !!finding.notes;
  const status = outcome(finding);

  function updateDraft(patch: Partial<Draft>) {
    setDraft((prev) => ({ ...prev, ...patch }));
  }

  return (
    <>
      <TableRow
        className={cn(
          finding.isNew && "bg-destructive/5",
          !finding.isNew && !finding.confirmedUnderCurrentVersion && "opacity-60",
        )}
      >
        <TableCell>
          <a
            href={finding.sourceUrl ?? undefined}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[12.5px] font-medium hover:underline"
          >
            {finding.cveId}
          </a>
          {!finding.confirmedUnderCurrentVersion && (
            <Badge variant="outline" className="ml-1.5 text-muted-foreground">
              Stale
            </Badge>
          )}
        </TableCell>
        <TableCell>
          {finding.severity && <Badge variant={SEVERITY_VARIANT[finding.severity] ?? "outline"}>{finding.severity}</Badge>}
          {finding.cvssScore != null && <span className="ml-1 text-[11px] text-muted-foreground">{finding.cvssScore.toFixed(1)}</span>}
        </TableCell>
        <TableCell className="max-w-[380px] truncate text-[12.5px] text-muted-foreground" title={finding.description ?? undefined}>
          {finding.description}
        </TableCell>
        <TableCell>
          <div className="flex items-center gap-1.5">
            <Badge variant={status.variant}>{status.label}</Badge>
            {finding.assessed && (
              <Tooltip>
                <TooltipTrigger render={<span className="inline-flex text-primary" />}>
                  <CheckCircle2 size={14} />
                </TooltipTrigger>
                <TooltipContent>Assessed</TooltipContent>
              </Tooltip>
            )}
          </div>
        </TableCell>
        <TableCell>
          <div className="flex items-center justify-end gap-1">
            {hasNote && (
              <Tooltip>
                <TooltipTrigger render={<button type="button" className="text-muted-foreground hover:text-foreground" />}>
                  <StickyNote size={14} />
                </TooltipTrigger>
                <TooltipContent side="left" className="max-w-xs whitespace-pre-wrap text-left">
                  {finding.rationale && <p>{finding.rationale}</p>}
                  {finding.notes && <p className={finding.rationale ? "mt-1 text-background/70" : undefined}>{finding.notes}</p>}
                </TooltipContent>
              </Tooltip>
            )}
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              onClick={() => {
                setDraft(draftOf(finding));
                setEditOpen(true);
              }}
            >
              <Pencil size={14} />
            </Button>
          </div>
        </TableCell>
      </TableRow>
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">{finding.cveId}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3.5">
            <p className="text-[12.5px] text-muted-foreground">{finding.description}</p>
            <div className="flex items-center justify-between gap-3">
              <span className="text-[13px]">Affects product</span>
              <Switch checked={draft.affectsProduct} onCheckedChange={(checked) => updateDraft({ affectsProduct: checked })} />
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-[13px]">False positive</span>
              <Switch checked={draft.falsePositive} onCheckedChange={(checked) => updateDraft({ falsePositive: checked })} />
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-[13px]">Assessed</span>
              <Checkbox checked={draft.assessed} onCheckedChange={(checked) => updateDraft({ assessed: checked })} />
            </div>
            {needsRationale && (
              <Textarea
                rows={3}
                className="text-[12.5px]"
                placeholder={draft.falsePositive ? "Why is this a false positive? (required)" : "Why doesn't this affect the product? (required)"}
                value={draft.rationale}
                onChange={(e) => updateDraft({ rationale: e.target.value })}
              />
            )}
            <div>
              <span className="mb-1 block text-[11px] text-muted-foreground">Notes (optional)</span>
              <Input className="text-[12.5px]" value={draft.notes} onChange={(e) => updateDraft({ notes: e.target.value })} />
            </div>
            {annotate.error && <p className="text-sm text-destructive">{annotate.error.message}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setEditOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={annotate.isPending || (needsRationale && !draft.rationale.trim())}
              onClick={() =>
                annotate.mutate({
                  nodeId,
                  cveId: finding.cveId,
                  assessed: draft.assessed,
                  affectsProduct: draft.affectsProduct,
                  falsePositive: draft.falsePositive,
                  rationale: draft.rationale,
                  notes: draft.notes,
                })
              }
            >
              {annotate.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
});
