"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc-client";
import { useState } from "react";

/** Lets a user "make it easy to find" the exact CPE string for an OTS component,
 * without knowing CPE syntax: searches NVD's own CPE database by keyword and picks a
 * candidate. Manual paste of a known CPE string is still available on the plain input
 * next to the "Find CPE" button that opens this dialog - this is a shortcut, not the
 * only way in. */
export function CpePickerDialog({
  open,
  onOpenChange,
  initialKeyword,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialKeyword: string;
  onSelect: (cpeName: string) => void;
}) {
  const [keyword, setKeyword] = useState(initialKeyword);
  const search = trpc.vulnerabilities.searchCpe.useMutation();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (next) {
          setKeyword(initialKeyword);
          search.reset();
        }
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Find CPE</DialogTitle>
        </DialogHeader>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (keyword.trim()) search.mutate({ keyword: keyword.trim() });
          }}
        >
          <Input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="e.g. Apache Log4j 2.14.1" />
          <Button type="submit" disabled={search.isPending || !keyword.trim()}>
            {search.isPending ? "Searching…" : "Search"}
          </Button>
        </form>
        {search.error && <p className="text-sm text-destructive">{search.error.message}</p>}
        {search.data && (
          <ul className="max-h-80 space-y-1 overflow-y-auto">
            {search.data.length === 0 ? (
              <p className="py-4 text-[13px] text-muted-foreground">No matches. Try a broader keyword.</p>
            ) : (
              search.data.map((candidate) => (
                <li key={candidate.cpeName} className="flex items-center justify-between gap-2 border border-border p-2">
                  <div className="min-w-0">
                    <p className="truncate text-[13px]">
                      {candidate.title} {candidate.deprecated && <Badge variant="outline">deprecated</Badge>}
                    </p>
                    <p className="truncate font-mono text-[11px] text-muted-foreground">{candidate.cpeName}</p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      onSelect(candidate.cpeName);
                      onOpenChange(false);
                    }}
                  >
                    Use this
                  </Button>
                </li>
              ))
            )}
          </ul>
        )}
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  );
}
