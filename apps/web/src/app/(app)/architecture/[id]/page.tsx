"use client";

import { ProductContextStrip } from "@/components/context-strip";
import { RequirementPicker } from "@/components/requirement-picker";
import { TestCasePicker } from "@/components/architecture-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc-client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useEffect, useRef, useState } from "react";

const KIND_LABEL = {
  software_item: "Software item",
  software_unit: "Software unit",
  ots: "OTS",
} as const;

const NO_PARENT = "none";

export default function ArchitectureDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const utils = trpc.useUtils();
  const detail = trpc.architecture.get.useQuery({ id });
  const updateNode = trpc.architecture.update.useMutation({
    onSuccess: () => {
      utils.architecture.get.invalidate({ id });
      utils.architecture.listTrace.invalidate();
      utils.architecture.listByProduct.invalidate();
    },
  });
  const deleteNode = trpc.architecture.delete.useMutation();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [parentId, setParentId] = useState<string>(NO_PARENT);
  const [parentTouched, setParentTouched] = useState(false);
  const [supplier, setSupplier] = useState("");
  const [version, setVersion] = useState("");
  const [requirementIds, setRequirementIds] = useState<string[]>([]);
  const [testCaseIds, setTestCaseIds] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  const hasInitializedRef = useRef(false);

  const productId = detail.data?.node.productId;
  const requirementOptions = trpc.requirements.listAllByProduct.useQuery(
    { productId: productId! },
    { enabled: !!productId },
  );
  const testCaseOptions = trpc.testCases.listAllByProduct.useQuery(
    { productId: productId! },
    { enabled: !!productId },
  );

  useEffect(() => {
    hasInitializedRef.current = false;
    setReady(false);
    setParentTouched(false);
  }, [id]);

  useEffect(() => {
    if (!detail.data || hasInitializedRef.current) return;
    hasInitializedRef.current = true;
    const { node, parent, requirementLinks, testCaseLinks } = detail.data;
    setTitle(node.title);
    setDescription(node.description);
    setParentId(parent?.id ?? NO_PARENT);
    setSupplier(node.supplier ?? "");
    setVersion(node.version ?? "");
    setRequirementIds(requirementLinks.map((l) => l.id));
    setTestCaseIds(testCaseLinks.map((l) => l.id));
    setReady(true);
  }, [detail.data]);

  if (detail.error) {
    return <p className="p-6 text-sm text-destructive">{detail.error.message}</p>;
  }
  if (detail.isLoading || !ready || !detail.data) {
    return <p className="p-6 text-sm text-muted-foreground">Loading...</p>;
  }

  const { node, children, parentOptions, canBeRoot } = detail.data;
  const displayId = node.displayId;
  const kind = node.kind as keyof typeof KIND_LABEL;

  function save() {
    const input: {
      id: string;
      title: string;
      description: string;
      parentId?: string | null;
      supplier?: string | null;
      version?: string | null;
      requirementIds: string[];
      testCaseIds: string[];
    } = { id, title, description, requirementIds, testCaseIds };
    if (parentTouched) {
      if (parentId !== NO_PARENT) input.parentId = parentId;
      else if (canBeRoot) input.parentId = null;
    }
    if (kind === "ots") {
      input.supplier = supplier || null;
      input.version = version || null;
    }
    updateNode.mutate(input);
  }

  return (
    <>
      <ProductContextStrip productId={node.productId} artifact="architecture" activeLevelId={node.levelId} />

      <div className="flex items-center justify-between border-b border-border bg-card px-5 py-[9px]">
        <span className="font-mono text-xs text-muted-foreground">
          <Link
            href={`/products/${node.productId}?artifact=architecture&level=${node.levelId}`}
            className="hover:text-foreground"
          >
            {node.levelCode}
          </Link>{" "}
          <span className="opacity-50">/</span> <span className="font-medium text-foreground">{displayId}</span>
        </span>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          disabled={deleteNode.isPending}
          onClick={() => {
            if (!confirm(`Delete ${displayId}?`)) return;
            deleteNode.mutate(
              { id },
              {
                onSuccess: () => {
                  router.push(`/products/${node.productId}?artifact=architecture&level=${node.levelId}`);
                },
              },
            );
          }}
        >
          {deleteNode.isPending ? "Deleting..." : "Delete"}
        </Button>
      </div>
      {deleteNode.error && <p className="px-5 pt-2 text-sm text-destructive">{deleteNode.error.message}</p>}

      <form
        className="mx-auto max-w-3xl space-y-5 p-5 pb-24"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div className="flex items-start gap-3.5 border-b border-border pb-3.5">
          <span className="mt-1.5 bg-foreground px-1.5 py-0.5 font-mono text-[13px] font-medium text-background">
            {displayId}
          </span>
          <div className="min-w-0 flex-1">
            <Input
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="h-auto border-0 bg-transparent p-0 font-heading text-[28px] leading-tight tracking-tight focus-visible:ring-0"
            />
            <div className="mt-1.5 flex items-center gap-2">
              <Badge variant="outline">{KIND_LABEL[kind]}</Badge>
            </div>
          </div>
        </div>

        <Label className="flex-col items-start gap-1">
          Parent
          <Select
            value={parentId}
            onValueChange={(v) => {
              if (!v) return;
              setParentId(v);
              setParentTouched(true);
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {canBeRoot && <SelectItem value={NO_PARENT}>Level root</SelectItem>}
              {parentOptions.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.displayId} {option.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Label>

        <Label className="flex-col items-start gap-1">
          Description
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={6} />
        </Label>

        {kind === "ots" && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Label className="flex-col items-start gap-1">
              Supplier
              <Input value={supplier} onChange={(e) => setSupplier(e.target.value)} />
            </Label>
            <Label className="flex-col items-start gap-1">
              Version
              <Input value={version} onChange={(e) => setVersion(e.target.value)} />
            </Label>
          </div>
        )}

        <Label className="flex-col items-start gap-1">
          <span className="text-xs font-medium text-muted-foreground">Linked requirements</span>
          <RequirementPicker
            options={requirementOptions.data ?? []}
            value={requirementIds}
            onChange={setRequirementIds}
          />
        </Label>

        <Label className="flex-col items-start gap-1">
          <span className="text-xs font-medium text-muted-foreground">Linked test cases</span>
          <TestCasePicker options={testCaseOptions.data ?? []} value={testCaseIds} onChange={setTestCaseIds} />
        </Label>

        {children.length > 0 && (
          <div>
            <p className="mb-1.5 font-mono text-[10.5px] tracking-[0.1em] text-muted-foreground uppercase">Children</p>
            <ul className="space-y-1">
              {children.map((child) => (
                <li key={child.id}>
                  <Link href={`/architecture/${child.id}`} className="font-mono text-[13px] hover:text-primary">
                    {child.displayId}
                  </Link>{" "}
                  <span className="text-[13.5px]">{child.title}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {updateNode.error && <p className="text-sm text-destructive">{updateNode.error.message}</p>}

        <div className="flex gap-2">
          <Button type="submit" disabled={updateNode.isPending}>
            {updateNode.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </>
  );
}
