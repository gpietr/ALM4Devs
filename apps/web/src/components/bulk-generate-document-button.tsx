"use client";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DocumentGenerationWizard, useExportDialogGuard } from "@/components/document-generation-wizard";
import { trpc } from "@/lib/trpc-client";
import { useState } from "react";

type BulkScope = "test_case" | "test_execution";

/**
 * "Select a bunch of test cases/executions and create separate reports for all of them...
 * download in one zip" (backlog item 9.32) - the multi-item sibling of
 * GenerateDocumentButton, now the same button-opens-a-wizard-modal shape (backlog item
 * 9.33), streaming its own progress while it runs (backlog item 9.34 - see
 * DocumentGenerationWizard's `streaming` prop and /api/documents/generate-bulk's own
 * docstring for the protocol). Selection itself (the checkboxes on the caller's list)
 * stays exactly as it was - only how the export form is triggered changed, per the
 * user's feedback that it was cluttering pages where it's an infrequently-used feature.
 * Renders nothing while nothing is selected, so this only appears once a bulk selection
 * actually exists.
 */
export function BulkGenerateDocumentButton({
  scope,
  ids,
  onDone,
}: {
  scope: BulkScope;
  ids: string[];
  /** Called after a successful download - the caller typically clears its selection. */
  onDone?: () => void;
}) {
  const templates = trpc.documentTemplates.list.useQuery({ scope });
  const [open, setOpen] = useState(false);
  const { wizardRef, setIsGenerating, confirmClose } = useExportDialogGuard();
  if (ids.length === 0 || templates.isLoading || (templates.data ?? []).length === 0) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (confirmClose(next)) setOpen(next);
      }}
    >
      <DialogTrigger render={<Button size="sm" />}>Export {ids.length} document{ids.length === 1 ? "" : "s"}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Export {ids.length} document{ids.length === 1 ? "" : "s"}
          </DialogTitle>
        </DialogHeader>
        <DocumentGenerationWizard
          ref={wizardRef}
          scope={scope}
          fetchUrl="/api/documents/generate-bulk"
          extraBody={scope === "test_case" ? { testCaseIds: ids } : { executionIds: ids }}
          fallbackFilename="documents.zip"
          streaming
          onGeneratingChange={setIsGenerating}
          onGenerated={() => {
            setOpen(false);
            onDone?.();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
