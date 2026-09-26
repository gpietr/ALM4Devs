"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { trpc } from "@/lib/trpc-client";
import { useState } from "react";

export function OtsGithubImportDialog({
  nodeId,
  initialUrl,
  open,
  onOpenChange,
  onImported,
}: {
  nodeId: string;
  initialUrl: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => Promise<unknown>;
}) {
  const preview = trpc.ots.previewGithubIssues.useMutation();
  const importIssues = trpc.ots.importGithubIssues.useMutation();
  const [url, setUrl] = useState(initialUrl);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const data = preview.data;
  const importable = data?.issues.filter((i) => !i.alreadyImported) ?? [];
  const allSelected = importable.length > 0 && importable.every((i) => selected.has(i.number));

  function fetchIssues() {
    setSelected(new Set());
    importIssues.reset();
    preview.mutate({ nodeId, url });
  }

  function toggle(number: number, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(number);
      else next.delete(number);
      return next;
    });
  }

  async function runImport() {
    if (!data) return;
    const issues = data.issues
      .filter((i) => selected.has(i.number))
      .map(({ number, title, body, htmlUrl, state, milestone }) => ({ number, title, body, htmlUrl, state, milestone }));
    await importIssues.mutateAsync({ nodeId, url: preview.variables?.url ?? url, issues });
    await onImported();
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Import from GitHub</DialogTitle>
        </DialogHeader>
        <p className="text-[12.5px] text-muted-foreground">
          Paste a GitHub issues URL - filters from the issues page (labels, state, search terms) carry over. Imported issues
          start unassessed.
        </p>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            fetchIssues();
          }}
        >
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://github.com/owner/repo/issues?q=is:issue+is:open+label:bug"
          />
          <Button type="submit" disabled={!url.trim() || preview.isPending}>
            {preview.isPending ? "Fetching…" : "Fetch"}
          </Button>
        </form>
        {preview.error && <p className="text-sm text-destructive">{preview.error.message}</p>}

        {data && (
          <>
            <p className="font-mono text-[11.5px] text-muted-foreground">{data.query}</p>
            {data.issues.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">No issues match.</p>
            ) : (
              <div className="rounded-md border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[36px]">
                        <Checkbox
                          checked={allSelected}
                          disabled={importable.length === 0}
                          onCheckedChange={(checked) => setSelected(new Set(checked ? importable.map((i) => i.number) : []))}
                        />
                      </TableHead>
                      <TableHead>Issue</TableHead>
                      <TableHead className="w-[90px]">State</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.issues.map((issue) => (
                      <TableRow key={issue.number} className={issue.alreadyImported ? "opacity-60" : undefined}>
                        <TableCell>
                          <Checkbox
                            checked={issue.alreadyImported || selected.has(issue.number)}
                            disabled={issue.alreadyImported}
                            onCheckedChange={(checked) => toggle(issue.number, !!checked)}
                          />
                        </TableCell>
                        <TableCell className="max-w-[520px]">
                          <div className="text-[13px]">
                            <span className="mr-1.5 font-mono text-[11.5px] text-muted-foreground">#{issue.number}</span>
                            <a href={issue.htmlUrl} target="_blank" rel="noreferrer" className="hover:underline">
                              {issue.title}
                            </a>
                            {issue.alreadyImported && (
                              <Badge variant="secondary" className="ml-1.5">
                                Imported
                              </Badge>
                            )}
                          </div>
                          {issue.labels.length > 0 && (
                            <div className="mt-0.5 flex flex-wrap gap-1">
                              {issue.labels.map((label) => (
                                <Badge key={label} variant="outline" className="text-[11px]">
                                  {label}
                                </Badge>
                              ))}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-[12.5px] text-muted-foreground">
                          {issue.state}
                          {issue.milestone && <div className="text-[11.5px]">{issue.milestone}</div>}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
            {data.truncated && (
              <p className="text-[12px] text-muted-foreground">
                Showing the newest {data.issues.length} of {data.totalCount} matching issues - narrow the filter to see the rest.
              </p>
            )}
          </>
        )}
        {importIssues.error && <p className="text-sm text-destructive">{importIssues.error.message}</p>}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={selected.size === 0 || importIssues.isPending} onClick={() => void runImport().catch(() => {})}>
            {importIssues.isPending ? "Importing…" : `Import ${selected.size} selected`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
