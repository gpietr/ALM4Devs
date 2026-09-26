"use client";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DocumentGenerationWizard, useExportDialogGuard } from "@/components/document-generation-wizard";
import { trpc } from "@/lib/trpc-client";
import { useState } from "react";

type Scope = "test_case" | "test_execution" | "requirement_list" | "ots_list" | "ots_component";

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
  const hasTemplates = useHasDocumentTemplates(scope);
  const [open, setOpen] = useState(false);
  if (!hasTemplates) return null;

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Export document
      </Button>
      <GenerateDocumentDialog scope={scope} open={open} onOpenChange={setOpen} buildRequestBody={buildRequestBody} />
    </>
  );
}

/** Callers hide their trigger until `scope` has a template. */
export function useHasDocumentTemplates(scope: Scope): boolean {
  const templates = trpc.documentTemplates.list.useQuery({ scope });
  return (templates.data ?? []).length > 0;
}

/** The export wizard modal alone, for other triggers (e.g. a menu item). */
export function GenerateDocumentDialog({
  scope,
  open,
  onOpenChange,
  buildRequestBody,
}: {
  scope: Scope;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  buildRequestBody: () => Record<string, unknown>;
}) {
  const { wizardRef, setIsGenerating, confirmClose } = useExportDialogGuard();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (confirmClose(next)) onOpenChange(next);
      }}
    >
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
          onGenerated={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
