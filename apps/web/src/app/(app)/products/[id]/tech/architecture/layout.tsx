"use client";

import { ProductContextStrip } from "@/components/context-strip";
import { Button } from "@/components/ui/button";
import { ALL_LEVELS, architectureNodeHref, entryHref } from "@/lib/product-nav";
import { trpc } from "@/lib/trpc-client";
import { confirmDiscardChanges, guardLinkClick } from "@/lib/unsaved-changes";
import { useActiveLevel } from "@/lib/use-active-level";
import { cn } from "cn";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, use, useEffect, useRef, useState } from "react";
import { Segmented, WorkspaceFrame } from "../workspace";
import { CreateNodeDialog, type CreateTarget, KIND_SHORT_LABEL, type NodeKind } from "./create-node-dialog";
import { MermaidPreview } from "./mermaid-preview";
import { TraceTable } from "./trace-table";

type View = "tree" | "trace" | "diagram";

const VIEWS: ReadonlyArray<{ value: View; label: string }> = [
  { value: "tree", label: "Tree" },
  { value: "trace", label: "Trace" },
  { value: "diagram", label: "Diagram" },
];

interface TreeNode {
  id: string;
  kind: NodeKind;
  title: string;
  displayId: string;
  children: TreeNode[];
}

/**
 * Architecture workspace: the level's tree left, the selected node (`[nodeId]`) right.
 * With nothing selected the right side shows the Diagram or Trace, per the Tree | Trace |
 * Diagram control. A layout so the tree keeps its state across selections.
 */
export default function ArchitectureWorkspaceLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id: productId } = use(params);
  const nodeId = useParams<{ nodeId?: string }>().nodeId ?? null;
  const router = useRouter();
  const searchParams = useSearchParams();
  const viewParam = searchParams.get("view");
  const view: View = viewParam === "trace" || viewParam === "diagram" ? viewParam : "tree";
  const tab = searchParams.get("tab");

  // A selected node pins its own level; a node that fails to load falls back to the
  // usual resolution so the tree still renders.
  const selected = trpc.architecture.get.useQuery({ id: nodeId! }, { enabled: !!nodeId, retry: false });
  const { activeLevelId, levels, isLoading, error } = useActiveLevel(
    productId,
    "architecture",
    searchParams.get("level"),
    nodeId && !selected.error ? (selected.data?.node.levelId ?? null) : undefined,
  );
  const levelId = activeLevelId === ALL_LEVELS ? null : activeLevelId;
  const tree = trpc.architecture.listByProduct.useQuery({ productId, levelId: levelId! }, { enabled: !!levelId });

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Only auto-expand genuinely new nodes, so a refetch doesn't reopen collapsed branches.
  const seenNodeIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!tree.data) return;
    const newIds = tree.data.nodes.filter((node) => !seenNodeIdsRef.current.has(node.id)).map((node) => node.id);
    seenNodeIdsRef.current = new Set(tree.data.nodes.map((node) => node.id));
    if (newIds.length === 0) return;
    setExpanded((prev) => new Set([...prev, ...newIds]));
  }, [tree.data]);
  // Reveal a node opened by URL even under a collapsed branch.
  useEffect(() => {
    const ancestors = selected.data?.ancestors;
    if (ancestors?.length) setExpanded((prev) => new Set([...prev, ...ancestors.map((a) => a.id)]));
  }, [selected.data?.ancestors]);

  const [create, setCreate] = useState<CreateTarget | null>(null);

  const nodeHref = (id: string) => architectureNodeHref(productId, id, { tab });
  const level = levels?.find((l) => l.id === levelId);

  function selectView(next: View) {
    if (!confirmDiscardChanges()) return;
    router.push(entryHref(productId, "architecture", { level: levelId, view: next === "tree" ? undefined : next }));
  }

  const strip = (
    <ProductContextStrip
      productId={productId}
      entry="architecture"
      activeLevelId={levelId}
      levelHref={(id) => entryHref(productId, "architecture", { level: id, view: viewParam })}
    />
  );

  if (error) {
    return (
      <>
        {strip}
        <p className="p-6 text-sm text-destructive">{error.message}</p>
      </>
    );
  }
  if (!isLoading && levels && levels.length === 0) {
    return (
      <>
        {strip}
        <div className="p-6">
          <h2 className="font-heading text-[34px] leading-[1.05] tracking-tight">Architecture</h2>
          <p className="mt-3 max-w-xl text-[13.5px] text-muted-foreground">
            This organization has no architecture levels yet.{" "}
            <Link href="/settings/architecture-levels" className="text-foreground underline-offset-4 hover:underline">
              Add one in Settings
            </Link>
            .
          </p>
        </div>
      </>
    );
  }

  return (
    <div className="flex min-h-screen flex-col">
      {strip}
      <WorkspaceFrame
        hasSelection={!!nodeId}
        list={
          <>
            <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
              <Segmented label="Right-side view" options={VIEWS} value={nodeId ? "tree" : view} onChange={selectView} />
              <div className="flex-1" />
              <Button
                type="button"
                size="sm"
                disabled={!levelId}
                onClick={() => setCreate({ kind: "software_item", parentId: null, parentLabel: null })}
              >
                <Plus strokeWidth={1.5} />
                Item
              </Button>
            </div>
            {tree.isLoading || !levelId ? (
              <p className="px-3 py-4 text-[13.5px] text-muted-foreground">Loading…</p>
            ) : tree.error ? (
              <p className="px-3 py-4 text-sm text-destructive">{tree.error.message}</p>
            ) : tree.data && tree.data.tree.length === 0 ? (
              <p className="px-3 py-6 text-[13.5px] text-muted-foreground">
                No software items yet. Add one to start this level&apos;s tree.
              </p>
            ) : (
              <ul className="py-1.5">
                {tree.data?.tree.map((node) => (
                  <TreeRow
                    key={node.id}
                    node={node as TreeNode}
                    depth={0}
                    selectedId={nodeId}
                    expanded={expanded}
                    hrefFor={nodeHref}
                    onToggle={(id) =>
                      setExpanded((prev) => {
                        const next = new Set(prev);
                        if (next.has(id)) next.delete(id);
                        else next.add(id);
                        return next;
                      })
                    }
                    onAdd={(parent, kind) =>
                      setCreate({ kind, parentId: parent.id, parentLabel: `${parent.displayId} ${parent.title}` })
                    }
                  />
                ))}
              </ul>
            )}
          </>
        }
      >
        {nodeId ? (
          children
        ) : levelId ? (
          <div className="p-6">
            <p className="font-mono text-[10.5px] tracking-[0.14em] text-muted-foreground uppercase">
              {level?.code} / {view === "trace" ? "Trace" : "Diagram"}
            </p>
            <h2 className="mt-0.5 mb-4 font-heading text-[34px] leading-[1.05] tracking-tight">{level?.name}</h2>
            {view === "trace" ? (
              <TraceTable productId={productId} levelId={levelId} />
            ) : tree.data ? (
              <MermaidPreview source={tree.data.mermaid} />
            ) : null}
          </div>
        ) : null}
      </WorkspaceFrame>

      {levelId && (
        <CreateNodeDialog
          productId={productId}
          levelId={levelId}
          target={create}
          onClose={() => setCreate(null)}
          onCreated={(id) => {
            setCreate(null);
            if (confirmDiscardChanges()) router.push(nodeHref(id));
          }}
        />
      )}
    </div>
  );
}

function TreeRow({
  node,
  depth,
  selectedId,
  expanded,
  hrefFor,
  onToggle,
  onAdd,
}: {
  node: TreeNode;
  depth: number;
  selectedId: string | null;
  expanded: Set<string>;
  hrefFor: (id: string) => string;
  onToggle: (id: string) => void;
  onAdd: (parent: TreeNode, kind: NodeKind) => void;
}) {
  const isOpen = expanded.has(node.id);
  const isSelected = node.id === selectedId;
  const hasChildren = node.kind !== "ots" && node.children.length > 0;
  // Containment rules: an item takes items, units and OTS; a unit takes OTS only.
  const addKinds: NodeKind[] =
    node.kind === "software_item" ? ["software_item", "software_unit", "ots"] : node.kind === "software_unit" ? ["ots"] : [];

  return (
    <li>
      <div
        className={cn(
          "flex items-center gap-1.5 border-l-[3px] py-1 pr-2.5",
          isSelected ? "border-primary bg-primary/10" : "border-transparent hover:bg-muted/50",
        )}
        style={{ paddingLeft: 6 + depth * 16 }}
      >
        {hasChildren ? (
          <button
            type="button"
            className="flex size-4 flex-none items-center justify-center text-muted-foreground hover:text-foreground"
            onClick={() => onToggle(node.id)}
            aria-label={isOpen ? "Collapse" : "Expand"}
            aria-expanded={isOpen}
          >
            {isOpen ? <ChevronDown className="size-3.5" strokeWidth={1.5} /> : <ChevronRight className="size-3.5" strokeWidth={1.5} />}
          </button>
        ) : (
          <span className="size-4 flex-none" />
        )}
        <Link
          href={hrefFor(node.id)}
          onClick={guardLinkClick}
          aria-current={isSelected ? "page" : undefined}
          className="flex min-w-0 flex-1 items-baseline gap-1.5"
        >
          <span className="flex-none font-mono text-xs font-medium">{node.displayId}</span>
          <span className={cn("truncate text-[13.5px]", isSelected && "font-medium")}>{node.title}</span>
        </Link>
        {isSelected && addKinds.length > 0 ? (
          <span className="flex flex-none gap-1">
            {addKinds.map((kind) => (
              <button
                key={kind}
                type="button"
                onClick={() => onAdd(node, kind)}
                className="border border-border bg-card px-1.5 font-mono text-[11px] text-foreground hover:border-foreground"
              >
                + {KIND_SHORT_LABEL[kind]}
              </button>
            ))}
          </span>
        ) : (
          node.kind !== "software_item" && (
            <span className="flex-none font-mono text-[10.5px] text-muted-foreground">{KIND_SHORT_LABEL[node.kind]}</span>
          )
        )}
      </div>
      {hasChildren && isOpen && (
        <ul>
          {node.children.map((child) => (
            <TreeRow
              key={child.id}
              node={child}
              depth={depth + 1}
              selectedId={selectedId}
              expanded={expanded}
              hrefFor={hrefFor}
              onToggle={onToggle}
              onAdd={onAdd}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
