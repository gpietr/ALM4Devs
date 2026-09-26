"use client";

import { CpePickerDialog } from "@/components/cpe-picker-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc-client";
import { type FormEvent, useState } from "react";

export type NodeKind = "software_item" | "software_unit" | "ots";

export const KIND_SHORT_LABEL: Record<NodeKind, string> = {
  software_item: "Item",
  software_unit: "Unit",
  ots: "OTS",
};

export interface CreateTarget {
  kind: NodeKind;
  parentId: string | null;
  /** e.g. "SWA-2 Glucose monitor". */
  parentLabel: string | null;
}

/** Creates a root item or a child node. A dialog because the OTS fields don't fit the
 * 320px tree column. */
export function CreateNodeDialog({
  productId,
  levelId,
  target,
  onClose,
  onCreated,
}: {
  productId: string;
  levelId: string;
  target: CreateTarget | null;
  onClose: () => void;
  onCreated: (nodeId: string) => void;
}) {
  const utils = trpc.useUtils();
  const createNode = trpc.architecture.create.useMutation({
    onSuccess: () => {
      utils.architecture.listByProduct.invalidate({ productId, levelId });
      utils.architecture.listTrace.invalidate({ productId, levelId });
      utils.ots.register.invalidate();
    },
  });
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [supplier, setSupplier] = useState("");
  const [version, setVersion] = useState("");
  const [cpe, setCpe] = useState("");
  const [cpePickerOpen, setCpePickerOpen] = useState(false);

  function reset() {
    setTitle("");
    setDescription("");
    setSupplier("");
    setVersion("");
    setCpe("");
    createNode.reset();
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!target) return;
    const isOts = target.kind === "ots";
    createNode.mutate(
      {
        productId,
        levelId,
        kind: target.kind,
        parentId: target.parentId ?? undefined,
        title,
        description: description || undefined,
        supplier: isOts ? supplier || undefined : undefined,
        version: isOts ? version || undefined : undefined,
        cpe: isOts ? cpe || undefined : undefined,
      },
      {
        onSuccess: ({ node }) => {
          reset();
          onCreated(node.id);
        },
      },
    );
  }

  return (
    <Dialog
      open={!!target}
      onOpenChange={(open) => {
        if (!open) {
          reset();
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            New {target ? KIND_SHORT_LABEL[target.kind].toLowerCase() : ""}
            {target?.parentLabel && <span className="font-normal text-muted-foreground"> under {target.parentLabel}</span>}
          </DialogTitle>
        </DialogHeader>
        <form id="create-architecture-node" onSubmit={submit} className="space-y-3">
          <Label className="flex-col items-start gap-1">
            Title
            <Input required autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
          </Label>
          <Label className="flex-col items-start gap-1">
            Description
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
          </Label>
          {target?.kind === "ots" && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <Label className="flex-col items-start gap-1">
                  Supplier
                  <Input value={supplier} onChange={(e) => setSupplier(e.target.value)} />
                </Label>
                <Label className="flex-col items-start gap-1">
                  Version
                  <Input value={version} onChange={(e) => setVersion(e.target.value)} />
                </Label>
              </div>
              <Label className="flex-col items-start gap-1">
                CPE
                <div className="flex w-full gap-2">
                  <Input
                    value={cpe}
                    onChange={(e) => setCpe(e.target.value)}
                    placeholder="cpe:2.3:a:vendor:product:version:*:*:*:*:*:*:*"
                    className="font-mono text-[12px]"
                  />
                  <Button type="button" variant="outline" onClick={() => setCpePickerOpen(true)}>
                    Find CPE
                  </Button>
                </div>
              </Label>
            </>
          )}
          {createNode.error && <p className="text-sm text-destructive">{createNode.error.message}</p>}
        </form>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              reset();
              onClose();
            }}
          >
            Cancel
          </Button>
          <Button type="submit" form="create-architecture-node" disabled={createNode.isPending}>
            {createNode.isPending ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
        {/* Outside the form: the picker has its own <form>, and React submit events
            bubble through portals to the enclosing one. */}
        <CpePickerDialog
          open={cpePickerOpen}
          onOpenChange={setCpePickerOpen}
          initialKeyword={[supplier, title, version].filter(Boolean).join(" ")}
          onSelect={setCpe}
        />
      </DialogContent>
    </Dialog>
  );
}
