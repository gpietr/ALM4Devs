"use client";

import { ProductContextStrip } from "@/components/context-strip";
import { Input } from "@/components/ui/input";
import { ALL_LEVELS, entryHref, otsItemHref } from "@/lib/product-nav";
import { trpc } from "@/lib/trpc-client";
import { confirmDiscardChanges, guardLinkClick } from "@/lib/unsaved-changes";
import { useActiveLevel } from "@/lib/use-active-level";
import { cn } from "cn";
import { Search } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, use, useState } from "react";
import { Segmented, WorkspaceFrame } from "../workspace";
import { OtsLevelTable } from "./ots-level-table";
import { OtsRegisterView } from "./ots-register-view";

type Display = "list" | "table";

const DISPLAYS: ReadonlyArray<{ value: Display; label: string }> = [
  { value: "list", label: "List" },
  { value: "table", label: "Table" },
];

/**
 * OTS workspace, scoped by the rail (ALL or one level). List: items left, the selected
 * one (`[otsId]`) right, keeping its tab across items. Table: the register at ALL, the
 * scanning table at a level; opening a row returns to List with it selected.
 */
export default function OtsWorkspaceLayout({ children, params }: { children: ReactNode; params: Promise<{ id: string }> }) {
  const { id: productId } = use(params);
  const otsId = useParams<{ otsId?: string }>().otsId ?? null;
  const router = useRouter();
  const searchParams = useSearchParams();
  const tab = searchParams.get("tab");
  const display: Display = !otsId && searchParams.get("display") === "table" ? "table" : "list";

  const { activeLevelId, error } = useActiveLevel(productId, "ots", searchParams.get("level"));
  const register = trpc.ots.register.useQuery({ productId });
  const products = trpc.products.list.useQuery();
  const productName = products.data?.find((p) => p.id === productId)?.name ?? "Product";
  const [filter, setFilter] = useState("");

  const inScope = (register.data ?? []).filter((r) => activeLevelId === ALL_LEVELS || r.node.levelId === activeLevelId);
  const needle = filter.trim().toLowerCase();
  const rows = needle
    ? inScope.filter((r) =>
        [r.node.title, r.node.displayId, r.node.supplier ?? ""].some((field) => field.toLowerCase().includes(needle)),
      )
    : inScope;
  const selectedLevelId = register.data?.find((r) => r.node.id === otsId)?.node.levelId ?? null;

  const itemHref = (nodeId: string, tabOverride?: string) =>
    otsItemHref(productId, nodeId, { level: activeLevelId, tab: tabOverride ?? tab });

  // Keep the open item across a level change only while it's still in scope.
  const levelHref = (levelId: string) =>
    otsId && (levelId === ALL_LEVELS || levelId === selectedLevelId)
      ? otsItemHref(productId, otsId, { level: levelId, tab })
      : entryHref(productId, "ots", { level: levelId, tab, display: display === "table" ? "table" : undefined });

  function selectDisplay(next: Display) {
    if (next === display || !confirmDiscardChanges()) return;
    router.push(entryHref(productId, "ots", { level: activeLevelId, tab, display: next === "table" ? "table" : undefined }));
  }

  const strip = <ProductContextStrip productId={productId} entry="ots" activeLevelId={activeLevelId} levelHref={levelHref} />;
  if (error) {
    return (
      <>
        {strip}
        <p className="p-6 text-sm text-destructive">{error.message}</p>
      </>
    );
  }

  if (display === "table") {
    return (
      <div className="flex min-h-screen flex-col">
        {strip}
        <div className="p-6">
          <div className="mb-4 flex items-center justify-between gap-4">
            <p className="font-mono text-[10.5px] tracking-[0.14em] text-muted-foreground uppercase">
              OTS · {activeLevelId === ALL_LEVELS ? "All levels" : "This level"}
            </p>
            <Segmented label="Display" options={DISPLAYS} value={display} onChange={selectDisplay} />
          </div>
          {activeLevelId === ALL_LEVELS ? (
            <OtsRegisterView productId={productId} productName={productName} itemHref={(id) => itemHref(id)} />
          ) : activeLevelId ? (
            <OtsLevelTable productId={productId} levelId={activeLevelId} itemHref={itemHref} />
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col">
      {strip}
      <WorkspaceFrame
        hasSelection={!!otsId}
        list={
          <>
            <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
              <div className="relative min-w-0 flex-1">
                <Search
                  className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
                  strokeWidth={1.5}
                />
                <Input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter OTS"
                  aria-label="Filter OTS"
                  className="h-7 pl-7 text-[13px]"
                />
              </div>
              <Segmented label="Display" options={DISPLAYS} value={display} onChange={selectDisplay} />
            </div>
            {register.isLoading ? (
              <p className="px-3 py-4 text-[13.5px] text-muted-foreground">Loading…</p>
            ) : register.error ? (
              <p className="px-3 py-4 text-sm text-destructive">{register.error.message}</p>
            ) : rows.length === 0 ? (
              <p className="px-3 py-6 text-[13.5px] text-muted-foreground">
                {needle
                  ? "No OTS items match this filter."
                  : activeLevelId === ALL_LEVELS
                    ? "No OTS items in this product yet. Add them from an item or unit in Architecture."
                    : "No OTS items on this level."}
              </p>
            ) : (
              <ul>
                {rows.map((r) => {
                  const isSelected = r.node.id === otsId;
                  return (
                    <li key={r.node.id}>
                      <Link
                        href={itemHref(r.node.id)}
                        onClick={guardLinkClick}
                        aria-current={isSelected ? "page" : undefined}
                        className={cn(
                          "block border-b border-l-[3px] border-b-foreground/9 px-3 py-2.5",
                          isSelected ? "border-l-primary bg-primary/10" : "border-l-transparent hover:bg-muted/50",
                        )}
                      >
                        <span className="flex items-baseline gap-2">
                          <span className={cn("min-w-0 flex-1 truncate text-[14px]", isSelected && "font-medium")}>
                            {r.node.title}
                          </span>
                          {r.currentVersion && (
                            <span
                              className={cn(
                                "flex-none font-mono text-[11.5px]",
                                isSelected ? "text-foreground" : "text-muted-foreground",
                              )}
                            >
                              {r.currentVersion.version}
                            </span>
                          )}
                        </span>
                        <span className="mt-0.5 block font-mono text-[11px] text-muted-foreground">{r.node.displayId}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        }
      >
        {otsId ? (
          children
        ) : (
          <div className="p-6">
            <p className="max-w-md text-[13.5px] text-muted-foreground">
              {rows.length > 0
                ? "Select an OTS item to open it. The tab you pick stays selected as you move down the list."
                : null}
            </p>
          </div>
        )}
      </WorkspaceFrame>
    </div>
  );
}
