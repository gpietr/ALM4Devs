"use client";

import { cn } from "cn";
import { usePathname } from "next/navigation";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";

const WorkspaceContext = createContext<{ toggleList: () => void } | null>(null);

/** The item header's list toggle (below 1024px); null outside a workspace. */
export function useWorkspaceList() {
  return useContext(WorkspaceContext);
}

/** A 320px collection column left, the selected item right. Below 1024px the column
 * becomes a drawer when an item is selected, and stacks on top otherwise. */
export function WorkspaceFrame({ list, hasSelection, children }: { list: ReactNode; hasSelection: boolean; children: ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const pathname = usePathname();
  useEffect(() => setDrawerOpen(false), [pathname]);

  return (
    <WorkspaceContext.Provider value={{ toggleList: () => setDrawerOpen((open) => !open) }}>
      <div className="flex flex-1 flex-col lg:flex-row">
        <aside
          className={cn(
            "flex-none border-border bg-card lg:w-80 lg:border-r",
            hasSelection
              ? drawerOpen
                ? "fixed inset-y-0 left-0 z-40 w-80 overflow-y-auto border-r shadow-lg lg:static lg:shadow-none"
                : "hidden lg:block"
              : "border-b lg:border-b-0",
          )}
        >
          {list}
        </aside>
        {hasSelection && drawerOpen && (
          <div aria-hidden className="fixed inset-0 z-30 bg-foreground/20 lg:hidden" onClick={() => setDrawerOpen(false)} />
        )}
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </WorkspaceContext.Provider>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T | null;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-none border border-border text-xs">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            "-ml-px px-2 py-1 first:ml-0",
            o.value === value ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
