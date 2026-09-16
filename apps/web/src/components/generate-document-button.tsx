"use client";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DocumentGenerationWizard, useExportDialogGuard } from "@/components/document-generation-wizard";
import { trpc } from "@/lib/trpc-client";
import { useState } from "react";

type Scope = "test_case" | "test_execution" | "requirement_list";

/**
 * "Export document" - the single-item export half of backlog item 9.29, now a button
 * that opens a small wizard modal (backlog item 9.33) rather than an always-visible
 * inline form - the user's feedback was that an infrequently-used export form was
 * cluttering pages that show it on every visit. Renders nothing at all if no template
 * exists for `scope` yet, same as before.
 */
export function GenerateDocumentButton({
  scope,
  buildRequestBody,
}: {
  scope: Scope;
  /** Returns the scope-specific fields the generate route needs (e.g. `{ testCaseId }`,
   * `{ executionId }`, or `{ requirementIds, productId, levelId }`) - called fresh each
   * time the wizard actually generates, so it can read current props/state rather than
   * being captured once. */
  buildRequestBody: () => Record<string, unknown>;
}) {
  const templates = trpc.documentTemplates.list.useQuery({ scope });
  const [open, setOpen] = useState(false);
  const { wizardRef, setIsGenerating, confirmClose } = useExportDialogGuard();

  const list = templates.data ?? [];
  if (templates.isLoading || list.length === 0) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (confirmClose(next)) setOpen(next);
      }}
    >
      <DialogTrigger render={<Button variant="outline" size="sm" />}>Export document</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Export document</DialogTitle>
        </DialogHeader>
        <DocumentGenerationWizard
          ref={wizardRef}
          scope={scope}
          fetchUrl="/api/documents/generate"
          extraBody={buildRequestBody()}
          fallbackFilename="document.pdf"
          onGeneratingChange={setIsGenerating}
          onGenerated={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
