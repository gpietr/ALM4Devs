"use client";

import { Frame } from "@/components/frame";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc-client";
import { useUrlState } from "@/lib/use-url-state";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";

type Kind = "software_item" | "software_unit" | "ots";

const KIND_LABEL: Record<Kind, string> = {
  software_item: "Item",
  software_unit: "Unit",
  ots: "OTS",
};

interface TreeNode {
  id: string;
  kind: Kind;
  title: string;
  displayId: string;
  children: TreeNode[];
}

export function ArchitectureSection({ productId, levelId }: { productId: string; levelId: string | null }) {
  const levels = trpc.architecture.listLevels.useQuery();
  const products = trpc.products.list.useQuery();
  const productName = products.data?.find((p) => p.id === productId)?.name ?? "Product";
  // Parent may still be resolving the URL/remembered level while listLevels already
  // returned; never sit on "Loading" once we have a level to show.
  const resolvedLevelId = levelId ?? levels.data?.[0]?.id ?? null;

  const { searchParams, setParams } = useUrlState();
  const view = searchParams.get("view") === "trace" ? "trace" : "tree";

  const utils = trpc.useUtils();
  const tree = trpc.architecture.listByProduct.useQuery(
    { productId, levelId: resolvedLevelId! },
    { enabled: !!resolvedLevelId && view === "tree" },
  );
  const trace = trpc.architecture.listTrace.useQuery(
    { productId, levelId: resolvedLevelId! },
    { enabled: !!resolvedLevelId && view === "trace" },
  );

  const createNode = trpc.architecture.create.useMutation({
    onSuccess: () => {
      if (resolvedLevelId) {
        utils.architecture.listByProduct.invalidate({ productId, levelId: resolvedLevelId });
        utils.architecture.listTrace.invalidate({ productId, levelId: resolvedLevelId });
      }
    },
  });

  const [create, setCreate] = useState<{ parentId: string | null; kind: Kind } | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [supplier, setSupplier] = useState("");
  const [version, setVersion] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Ids we've already decided an expand/collapse state for, so a refetch triggered by an
  // unrelated edit elsewhere in the tree (create/rename/delete anywhere in this level all
  // invalidate the same listByProduct query) only auto-expands nodes that are genuinely
  // new, instead of re-adding every existing id and silently reopening whatever the user
  // had manually collapsed.
  const seenNodeIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    setCreate(null);
  }, [resolvedLevelId]);

  useEffect(() => {
    if (!tree.data) return;
    const newIds = tree.data.nodes.filter((node) => !seenNodeIdsRef.current.has(node.id)).map((node) => node.id);
    seenNodeIdsRef.current = new Set(tree.data.nodes.map((node) => node.id));
    if (newIds.length === 0) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const id of newIds) next.add(id);
      return next;
    });
  }, [tree.data]);

  if (levels.isLoading) {
    return <p className="p-6 text-[13.5px] text-muted-foreground">Loading...</p>;
  }
  if (levels.error) {
    return <p className="p-6 text-sm text-destructive">{levels.error.message}</p>;
  }
  if (!levels.data?.length || !resolvedLevelId) {
    return (
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
    );
  }

  const levelName = levels.data.find((l) => l.id === resolvedLevelId)?.name ?? "Architecture";

  function openCreate(parentId: string | null, kind: Kind) {
    setCreate({ parentId, kind });
    setTitle("");
    setDescription("");
    setSupplier("");
    setVersion("");
  }

  function submitCreate(e: FormEvent) {
    e.preventDefault();
    if (!create || !resolvedLevelId) return;
    createNode.mutate(
      {
        productId,
        levelId: resolvedLevelId,
        kind: create.kind,
        parentId: create.parentId ?? undefined,
        title,
        description: description || undefined,
        supplier: create.kind === "ots" ? supplier || undefined : undefined,
        version: create.kind === "ots" ? version || undefined : undefined,
      },
      { onSuccess: () => setCreate(null) },
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-end justify-between gap-6">
        <div>
          <p className="font-mono text-[10.5px] tracking-[0.14em] text-muted-foreground uppercase">
            {productName} / {levelName}
          </p>
          <h2 className="mt-0.5 font-heading text-[34px] leading-[1.05] tracking-tight">{levelName}</h2>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex border border-border bg-card text-[13px]">
            <button
              type="button"
              className={`px-3 py-1.5 ${view === "tree" ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"}`}
              onClick={() => setParams({ view: undefined })}
            >
              Tree
            </button>
            <button
              type="button"
              className={`px-3 py-1.5 ${view === "trace" ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"}`}
              onClick={() => setParams({ view: "trace" })}
            >
              Trace
            </button>
          </div>
          {view === "tree" && (
            <Button type="button" className="gap-1.5" onClick={() => openCreate(null, "software_item")}>
              <Plus className="size-3.5" />
              New software item
            </Button>
          )}
        </div>
      </div>

      {view === "tree" && (
        <>
          {tree.isLoading && <p className="mt-4 text-[13.5px] text-muted-foreground">Loading...</p>}
          {tree.error && <p className="mt-4 text-sm text-destructive">{tree.error.message}</p>}

          {tree.data && (
            <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(280px,360px)_1fr]">
              <Frame className="bg-card p-3">
                {create && (
                  <form onSubmit={submitCreate} className="mb-3 space-y-2 border border-border bg-background p-3">
                    <p className="font-mono text-[10.5px] tracking-[0.1em] text-muted-foreground uppercase">
                      New {KIND_LABEL[create.kind]}
                    </p>
                    <Label className="flex-col items-start gap-1">
                      Title
                      <Input required value={title} onChange={(e) => setTitle(e.target.value)} />
                    </Label>
                    <Label className="flex-col items-start gap-1">
                      Description
                      <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
                    </Label>
                    {create.kind === "ots" && (
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
                    )}
                    {createNode.error && <p className="text-sm text-destructive">{createNode.error.message}</p>}
                    <div className="flex gap-2">
                      <Button type="submit" size="sm" disabled={createNode.isPending}>
                        {createNode.isPending ? "Creating…" : "Create"}
                      </Button>
                      <Button type="button" size="sm" variant="outline" onClick={() => setCreate(null)}>
                        Cancel
                      </Button>
                    </div>
                  </form>
                )}
                {tree.data.tree.length === 0 && !create ? (
                  <p className="px-1 py-6 text-[13.5px] text-muted-foreground">
                    No software items yet. Add one to start this level&apos;s tree.
                  </p>
                ) : (
                  <ul className="space-y-0.5">
                    {tree.data.tree.map((node) => (
                      <TreeRow
                        key={node.id}
                        node={node}
                        expanded={expanded}
                        onToggle={(id) =>
                          setExpanded((prev) => {
                            const next = new Set(prev);
                            if (next.has(id)) next.delete(id);
                            else next.add(id);
                            return next;
                          })
                        }
                        onAdd={openCreate}
                      />
                    ))}
                  </ul>
                )}
              </Frame>

              <Frame className="bg-card p-3">
                <p className="mb-2 font-mono text-[10.5px] tracking-[0.1em] text-muted-foreground uppercase">Diagram</p>
                <MermaidPreview source={tree.data.mermaid} />
              </Frame>
            </div>
          )}
        </>
      )}

      {view === "trace" && (
        <>
          {trace.isLoading && <p className="mt-4 text-[13.5px] text-muted-foreground">Loading...</p>}
          {trace.error && <p className="mt-4 text-sm text-destructive">{trace.error.message}</p>}
          {trace.data && (
            <Frame className="mt-4 bg-card">
              {trace.data.rows.length === 0 ? (
                <p className="px-4 py-6 text-[13.5px] text-muted-foreground">
                  No architecture nodes on this level yet.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[110px]">ID</TableHead>
                      <TableHead className="w-[72px]">Kind</TableHead>
                      <TableHead>Node</TableHead>
                      <TableHead>Requirements</TableHead>
                      <TableHead>Test cases</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {trace.data.rows.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell>
                          <Link href={`/architecture/${row.id}`} className="font-mono text-[13px] font-medium text-foreground">
                            {row.displayId}
                          </Link>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">{KIND_LABEL[row.kind]}</Badge>
                        </TableCell>
                        <TableCell className="max-w-xs whitespace-normal">
                          <Link href={`/architecture/${row.id}`} className="text-foreground hover:underline">
                            {row.title}
                          </Link>
                        </TableCell>
                        <TableCell className="max-w-sm whitespace-normal text-[13px]">
                          {row.requirementLinks.length > 0 ? (
                            row.requirementLinks.map((r, i) => (
                              <span key={r.id}>
                                {i > 0 && ", "}
                                <Link href={`/requirements/${r.id}`} className="font-mono text-[12.5px] hover:text-primary">
                                  {r.displayId}
                                </Link>
                              </span>
                            ))
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="max-w-sm whitespace-normal text-[13px]">
                          {row.testCaseLinks.length > 0 ? (
                            row.testCaseLinks.map((tc, i) => (
                              <span key={tc.id}>
                                {i > 0 && ", "}
                                <Link href={`/test-cases/${tc.id}`} className="font-mono text-[12.5px] hover:text-primary">
                                  {tc.displayId}
                                </Link>
                              </span>
                            ))
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </Frame>
          )}
        </>
      )}
    </div>
  );
}

function TreeRow({
  node,
  expanded,
  onToggle,
  onAdd,
}: {
  node: TreeNode;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  onAdd: (parentId: string | null, kind: Kind) => void;
}) {
  const isOpen = expanded.has(node.id);
  const canHaveChildren = node.kind !== "ots";
  return (
    <li>
      <div className="flex items-center gap-1 py-0.5">
        {canHaveChildren && node.children.length > 0 ? (
          <button
            type="button"
            className="flex size-5 items-center justify-center text-muted-foreground"
            onClick={() => onToggle(node.id)}
            aria-label={isOpen ? "Collapse" : "Expand"}
          >
            {isOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </button>
        ) : (
          <span className="size-5" />
        )}
        <Link href={`/architecture/${node.id}`} className="min-w-0 flex-1 truncate text-[13.5px] hover:text-primary">
          <span className="font-mono text-xs font-medium">{node.displayId}</span>{" "}
          <span className="text-foreground">{node.title}</span>
        </Link>
        <Badge variant="outline">{KIND_LABEL[node.kind]}</Badge>
        {node.kind === "software_item" && (
          <div className="flex items-center gap-0.5">
            <AddChildButton label="Item" onClick={() => onAdd(node.id, "software_item")} />
            <AddChildButton label="Unit" onClick={() => onAdd(node.id, "software_unit")} />
            <AddChildButton label="OTS" onClick={() => onAdd(node.id, "ots")} />
          </div>
        )}
        {node.kind === "software_unit" && (
          <div className="flex items-center gap-0.5">
            <AddChildButton label="OTS" onClick={() => onAdd(node.id, "ots")} />
          </div>
        )}
      </div>
      {canHaveChildren && isOpen && node.children.length > 0 && (
        <ul className="ml-4 border-l border-border pl-2">
          {node.children.map((child) => (
            <TreeRow key={child.id} node={child} expanded={expanded} onToggle={onToggle} onAdd={onAdd} />
          ))}
        </ul>
      )}
    </li>
  );
}

function AddChildButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="border border-border px-1 py-0 font-mono text-[10px] text-muted-foreground hover:text-foreground"
    >
      +{label}
    </button>
  );
}

let mermaidInit: Promise<typeof import("mermaid")> | null = null;
function mermaidApi() {
  if (!mermaidInit) {
    mermaidInit = import("mermaid").then((mod) => {
      mod.default.parseError = () => {};
      mod.default.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "neutral",
        layout: "dagre",
      });
      return mod;
    });
  }
  return mermaidInit;
}

function scrubMermaidTemp(id: string, sandbox?: HTMLElement, keep?: HTMLElement | null) {
  sandbox?.remove();
  for (const el of [document.getElementById(id), document.getElementById(`d${id}`), document.getElementById(`${id}-svg`)]) {
    if (el && !keep?.contains(el)) el.remove();
  }
}

function MermaidPreview({ source }: { source: string }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.replaceChildren();
    if (!source.trim()) return;

    let cancelled = false;
    const renderId = `archdiag${Math.random().toString(36).slice(2)}`;
    const sandbox = document.createElement("div");
    sandbox.setAttribute("aria-hidden", "true");
    sandbox.style.cssText = "position:absolute;left:-9999px;top:0;width:0;height:0;overflow:hidden";
    document.body.appendChild(sandbox);

    (async () => {
      try {
        const mermaid = (await mermaidApi()).default;
        const { svg } = await mermaid.render(renderId, source, sandbox);
        if (cancelled) return;
        if (/syntax error/i.test(svg)) return;
        host.innerHTML = svg;
      } catch {
        // Keep the panel empty rather than mermaid's default error SVG, which it
        // otherwise appends to document.body (it showed up under the create form).
      } finally {
        scrubMermaidTemp(renderId, sandbox, host);
      }
    })();

    return () => {
      cancelled = true;
      scrubMermaidTemp(renderId, sandbox, host);
    };
  }, [source]);

  if (!source.trim()) {
    return <p className="text-xs text-muted-foreground">No diagram yet.</p>;
  }
  return (
    <div
      ref={hostRef}
      className="overflow-auto border border-border bg-background p-3 [&_svg]:mx-auto [&_svg]:max-w-full"
    />
  );
}
