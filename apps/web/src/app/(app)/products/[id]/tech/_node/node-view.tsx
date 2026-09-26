"use client";

import { TestCasePicker } from "@/components/architecture-picker";
import { GenerateDocumentDialog, useHasDocumentTemplates } from "@/components/generate-document-button";
import { RequirementPicker } from "@/components/requirement-picker";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { architectureNodeHref, entryHref } from "@/lib/product-nav";
import { trpc } from "@/lib/trpc-client";
import type { AppRouter } from "@/server/routers/_app";
import type { inferRouterOutputs } from "@trpc/server";
import { confirmDiscardChanges, guardLinkClick, useUnsavedChanges } from "@/lib/unsaved-changes";
import { useUrlState } from "@/lib/use-url-state";
import { cn } from "cn";
import { MoreHorizontal, PanelLeft } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, type ReactNode, useState } from "react";
import { CATEGORY_LABEL } from "../ots/ots-register-view";
import { useWorkspaceList } from "../workspace";
import { OtsAnomaliesSection } from "./ots-anomalies-section";
import { OtsDocumentationSection } from "./ots-documentation-section";
import { OtsVersionsTab } from "./ots-versions-tab";
import { VulnerabilitiesSection } from "./vulnerabilities-section";

const KIND_LABEL = {
  software_item: "Software item",
  software_unit: "Software unit",
  ots: "OTS",
} as const;

const NO_PARENT = "none";

const NODE_TABS = [
  { value: "overview", label: "Overview" },
  { value: "versions", label: "Versions" },
  { value: "documentation", label: "Documentation" },
  { value: "known-issues", label: "Known issues" },
  { value: "vulnerabilities", label: "Vulnerabilities" },
] as const;
type NodeTab = (typeof NODE_TABS)[number]["value"];

/** Items and units only have Overview; the param is left alone so the next OTS item
 * reopens that tab. */
function readNodeTab(param: string | null, isOts: boolean): NodeTab {
  if (!isOts) return "overview";
  return NODE_TABS.some((t) => t.value === param) ? (param as NodeTab) : "overview";
}

type Detail = inferRouterOutputs<AppRouter>["architecture"]["get"];

/** An architecture node in a workspace: item header and tabs (`?tab=`). Remounts per
 * node, so editor drafts start fresh for each item. */
export function NodeView({ nodeId, workspace }: { nodeId: string; workspace: "ots" | "architecture" }) {
  const { searchParams, setParams } = useUrlState();
  const detail = trpc.architecture.get.useQuery({ id: nodeId });

  if (detail.error) {
    return <p className="p-6 text-sm text-destructive">{detail.error.message}</p>;
  }
  if (!detail.data) {
    return <p className="p-6 text-sm text-muted-foreground">Loading…</p>;
  }

  const { node } = detail.data;
  const isOts = node.kind === "ots";
  const tab = readNodeTab(searchParams.get("tab"), isOts);
  const tabs = isOts ? NODE_TABS : NODE_TABS.slice(0, 1);

  function selectTab(next: NodeTab) {
    if (next === tab || !confirmDiscardChanges()) return;
    setParams({ tab: next === "overview" ? undefined : next });
  }

  return (
    <>
      <NodeHeader detail={detail.data} workspace={workspace}>
        <div role="tablist" className="mt-2 flex gap-6 overflow-x-auto">
          {tabs.map((t) => (
            <button
              key={t.value}
              type="button"
              role="tab"
              aria-selected={t.value === tab}
              onClick={() => selectTab(t.value)}
              className={cn(
                "border-b-2 pt-1.5 pb-2.5 font-heading text-[13.5px] tracking-[0.1em] whitespace-nowrap uppercase",
                t.value === tab ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </NodeHeader>

      <div role="tabpanel" className="max-w-[1120px] px-6 pt-4 pb-6">
        {tab === "versions" ? (
          <OtsVersionsTab detail={detail.data} />
        ) : tab === "documentation" ? (
          <DocumentationTab nodeId={nodeId} productId={node.productId} />
        ) : tab === "known-issues" ? (
          <OtsAnomaliesSection nodeId={nodeId} productId={node.productId} />
        ) : tab === "vulnerabilities" ? (
          <VulnerabilitiesSection nodeId={nodeId} />
        ) : (
          <OverviewForm detail={detail.data} />
        )}
      </div>
    </>
  );
}

function NodeHeader({ detail, workspace, children }: { detail: Detail; workspace: "ots" | "architecture"; children: ReactNode }) {
  const router = useRouter();
  const { searchParams } = useUrlState();
  const utils = trpc.useUtils();
  const workspaceList = useWorkspaceList();
  const { node, ancestors } = detail;
  const isOts = node.kind === "ots";

  const documentation = trpc.ots.documentation.useQuery({ nodeId: node.id }, { enabled: isOts });
  const category = documentation.data?.profile.category;
  const meta = isOts
    ? [category ? (CATEGORY_LABEL[category] ?? category) : null, node.supplier].filter(Boolean).join(" · ") || KIND_LABEL.ots
    : KIND_LABEL[node.kind];

  const canGenerate = useHasDocumentTemplates("ots_component");
  const [generateOpen, setGenerateOpen] = useState(false);

  const deleteNode = trpc.architecture.delete.useMutation();
  function remove() {
    if (!confirmDiscardChanges()) return;
    if (!window.confirm(`Delete ${node.displayId}?`)) return;
    deleteNode.mutate(
      { id: node.id },
      {
        onSuccess: () => {
          utils.architecture.listByProduct.invalidate();
          utils.architecture.listTrace.invalidate();
          utils.ots.register.invalidate();
          router.push(
            workspace === "ots"
              ? entryHref(node.productId, "ots", { level: searchParams.get("level"), tab: searchParams.get("tab") })
              : entryHref(node.productId, "architecture", { level: node.levelId }),
          );
        },
      },
    );
  }

  return (
    <div className="border-b border-border bg-card px-6 pt-3.5">
      <p className="font-mono text-[11.5px] text-muted-foreground">
        <Link
          href={entryHref(node.productId, "architecture", { level: node.levelId })}
          onClick={guardLinkClick}
          className="text-foreground hover:underline"
        >
          {node.levelCode}
        </Link>
        {ancestors.map((a) => (
          <Fragment key={a.id}>
            {" "}
            <span className="opacity-50">/</span>{" "}
            <Link href={architectureNodeHref(node.productId, a.id)} onClick={guardLinkClick} className="hover:underline">
              <span className="text-foreground">{a.displayId}</span> {a.title}
            </Link>
          </Fragment>
        ))}
      </p>

      <div className="mt-1 flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <span className="bg-foreground px-[7px] py-px font-mono text-[13px] font-medium text-background">{node.displayId}</span>
          <h2 className="min-w-0 font-heading text-[30px] leading-tight">{node.title}</h2>
          <span className="text-[13px] text-muted-foreground">{meta}</span>
          {isOts && node.currentVersion && (
            <span className="flex items-stretch border border-border font-mono">
              <span className="px-1.5 text-[12px]">{node.currentVersion.version}</span>
              <span className="flex items-center border-l border-border px-1.5 text-[10px] tracking-[0.1em] text-muted-foreground">
                CURRENT
              </span>
            </span>
          )}
        </div>
        <div className="flex flex-none items-center gap-1.5 pt-1">
          {workspaceList && (
            <Button
              type="button"
              variant="outline"
              className="h-[30px] w-8 p-0 lg:hidden"
              aria-label={workspace === "ots" ? "Show OTS list" : "Show tree"}
              onClick={workspaceList.toggleList}
            >
              <PanelLeft className="size-4" strokeWidth={1.5} />
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button type="button" variant="outline" className="h-[30px] w-8 p-0" aria-label="More actions" />}
            >
              <MoreHorizontal className="size-4" strokeWidth={1.5} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              {isOts && canGenerate && (
                <>
                  <DropdownMenuItem onClick={() => setGenerateOpen(true)}>Generate document</DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuItem variant="destructive" disabled={deleteNode.isPending} onClick={remove}>
                {deleteNode.isPending ? "Deleting…" : `Delete ${node.displayId}`}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {deleteNode.error && <p className="mt-1 text-sm text-destructive">{deleteNode.error.message}</p>}

      {children}

      {isOts && (
        <GenerateDocumentDialog
          scope="ots_component"
          open={generateOpen}
          onOpenChange={setGenerateOpen}
          buildRequestBody={() => ({ architectureNodeId: node.id })}
        />
      )}
    </div>
  );
}

function DocumentationTab({ nodeId, productId }: { nodeId: string; productId: string }) {
  const [dirty, setDirty] = useState(false);
  useUnsavedChanges(`node:${nodeId}:documentation`, dirty);
  return <OtsDocumentationSection nodeId={nodeId} productId={productId} onDirtyChange={setDirty} />;
}

function sameIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

/** The node's own fields; OTS version controls live in the Versions tab. */
function OverviewForm({ detail }: { detail: Detail }) {
  const utils = trpc.useUtils();
  const { node, parent, children, parentOptions, canBeRoot, requirementLinks, testCaseLinks } = detail;
  const isOts = node.kind === "ots";
  const initialParentId = parent?.id ?? NO_PARENT;

  const [title, setTitle] = useState(node.title);
  const [description, setDescription] = useState(node.description);
  const [parentId, setParentId] = useState<string>(initialParentId);
  const [supplier, setSupplier] = useState(node.supplier ?? "");
  const [requirementIds, setRequirementIds] = useState<string[]>(() => requirementLinks.map((l) => l.id));
  const [testCaseIds, setTestCaseIds] = useState<string[]>(() => testCaseLinks.map((l) => l.id));

  const requirementOptions = trpc.requirements.listAllByProduct.useQuery({ productId: node.productId });
  const testCaseOptions = trpc.testCases.listAllByProduct.useQuery({ productId: node.productId });
  const updateNode = trpc.architecture.update.useMutation({
    onSuccess: () => {
      utils.architecture.get.invalidate({ id: node.id });
      utils.architecture.listTrace.invalidate();
      utils.architecture.listByProduct.invalidate();
      utils.ots.register.invalidate();
    },
  });

  // Compared with the fetched node, so the refetch after a save clears it.
  const parentChanged = parentId !== initialParentId;
  const dirty =
    title !== node.title ||
    description !== node.description ||
    parentChanged ||
    (isOts && supplier !== (node.supplier ?? "")) ||
    !sameIds(requirementIds, requirementLinks.map((l) => l.id)) ||
    !sameIds(testCaseIds, testCaseLinks.map((l) => l.id));
  useUnsavedChanges(`node:${node.id}:overview`, dirty);

  function save() {
    const input: {
      id: string;
      title: string;
      description: string;
      parentId?: string | null;
      supplier?: string | null;
      requirementIds: string[];
      testCaseIds: string[];
    } = { id: node.id, title, description, requirementIds, testCaseIds };
    if (parentChanged) {
      if (parentId !== NO_PARENT) input.parentId = parentId;
      else if (canBeRoot) input.parentId = null;
    }
    if (isOts) input.supplier = supplier || null;
    updateNode.mutate(input);
  }

  return (
    <form
      className="pb-24"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <div className="grid gap-x-6 gap-y-4 sm:grid-cols-[120px_minmax(0,1fr)]">
        <FieldLabel htmlFor="node-title">Title</FieldLabel>
        <Input id="node-title" required value={title} onChange={(e) => setTitle(e.target.value)} />

        <FieldLabel>Parent</FieldLabel>
        <Select value={parentId} onValueChange={(v) => v && setParentId(v)}>
          <SelectTrigger aria-label="Parent" className="w-full">
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

        <FieldLabel htmlFor="node-description">Description</FieldLabel>
        <Textarea id="node-description" value={description} onChange={(e) => setDescription(e.target.value)} rows={6} />

        {isOts && (
          <>
            <FieldLabel htmlFor="node-supplier">Supplier</FieldLabel>
            <Input id="node-supplier" value={supplier} onChange={(e) => setSupplier(e.target.value)} />
          </>
        )}

        <FieldLabel>Requirements</FieldLabel>
        <RequirementPicker options={requirementOptions.data ?? []} value={requirementIds} onChange={setRequirementIds} />

        <FieldLabel>Test cases</FieldLabel>
        <TestCasePicker options={testCaseOptions.data ?? []} value={testCaseIds} onChange={setTestCaseIds} />

        {children.length > 0 && (
          <>
            <FieldLabel>Children</FieldLabel>
            <ul className="space-y-1 pt-1.5">
              {children.map((child) => (
                <li key={child.id}>
                  <Link
                    href={architectureNodeHref(node.productId, child.id)}
                    onClick={guardLinkClick}
                    className="font-mono text-[13px] hover:text-primary"
                  >
                    {child.displayId}
                  </Link>{" "}
                  <span className="text-[13.5px]">{child.title}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {updateNode.error && <p className="mt-4 text-sm text-destructive">{updateNode.error.message}</p>}
      <div className="mt-6 flex items-center gap-3 border-t border-border pt-4">
        <Button type="submit" disabled={updateNode.isPending || !dirty}>
          {updateNode.isPending ? "Saving…" : "Save"}
        </Button>
        {dirty && <span className="text-[12.5px] text-muted-foreground">Unsaved changes</span>}
      </div>
    </form>
  );
}

function FieldLabel({ htmlFor, children }: { htmlFor?: string; children: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="pt-1.5 text-[12.5px] text-muted-foreground">
      {children}
    </label>
  );
}
