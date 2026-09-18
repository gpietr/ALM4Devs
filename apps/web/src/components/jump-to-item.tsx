"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { formatItemId } from "@/lib/format-item-id";
import { trpc } from "@/lib/trpc-client";
import { cn } from "cn";
import { Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

interface JumpItem {
  href: string;
  displayId: string;
  title: string;
  kind: "requirement" | "architecture" | "test case";
}

/**
 * The shell's "Jump to item" search (⌘K) - a quick filter over the current product's
 * requirements and test cases by id or title, navigating straight to whichever one is
 * picked. Scoped to one product, not the whole tenant, matching every other list/query
 * in this app (requirements.listAllByProduct/testCases.listAllByProduct, both already
 * used elsewhere for requirement-link pickers - this is the same data, just searched
 * instead of picked from a dropdown). Renders as an inert, disabled affordance outside a
 * product context (Settings, the product list, home) rather than pretending there's
 * something to search there.
 */
export function JumpToItem({ productId }: { productId: string | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (productId) setOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [productId]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setHighlighted(0);
    }
  }, [open]);

  const requirements = trpc.requirements.listAllByProduct.useQuery(
    { productId: productId ?? "" },
    { enabled: open && !!productId },
  );
  const architecture = trpc.architecture.listAllByProduct.useQuery(
    { productId: productId ?? "" },
    { enabled: open && !!productId },
  );
  const testCases = trpc.testCases.listAllByProduct.useQuery(
    { productId: productId ?? "" },
    { enabled: open && !!productId },
  );

  const items: JumpItem[] = useMemo(() => {
    const reqs = (requirements.data ?? []).map((r) => ({
      href: `/requirements/${r.id}`,
      displayId: formatItemId(r.levelCode, r.sequenceNumber),
      title: r.title,
      kind: "requirement" as const,
    }));
    const arch = (architecture.data ?? []).map((n) => ({
      href: `/architecture/${n.id}`,
      displayId: formatItemId(n.levelCode, n.sequenceNumber),
      title: n.title,
      kind: "architecture" as const,
    }));
    const tcs = (testCases.data ?? []).map((t) => ({
      href: `/test-cases/${t.id}`,
      displayId: formatItemId(t.levelCode, t.sequenceNumber),
      title: t.title,
      kind: "test case" as const,
    }));
    return [...reqs, ...arch, ...tcs];
  }, [requirements.data, architecture.data, testCases.data]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = needle
      ? items.filter((i) => i.displayId.toLowerCase().includes(needle) || i.title.toLowerCase().includes(needle))
      : items;
    return matches.slice(0, 30);
  }, [items, query]);

  // Clamp rather than reset on every keystroke - so re-filtering down to fewer rows
  // doesn't jump the highlight back to the top mid-type.
  const activeIndex = Math.min(highlighted, Math.max(filtered.length - 1, 0));

  function go(item: JumpItem | undefined) {
    if (!item) return;
    setOpen(false);
    router.push(item.href);
  }

  const loading = requirements.isLoading || architecture.isLoading || testCases.isLoading;

  return (
    <>
      <button
        type="button"
        disabled={!productId}
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 border-l border-border px-3.5 text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-45"
      >
        <Search className="size-[15px]" strokeWidth={1.5} />
        <span className="text-[13.5px]">Jump to item</span>
        <span className="border border-border px-1 font-mono text-[10.5px]">⌘K</span>
      </button>

      <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/20 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
          <DialogPrimitive.Popup
            initialFocus={inputRef}
            className="fixed top-[18vh] left-1/2 z-50 w-full max-w-lg -translate-x-1/2 border border-border bg-card text-sm outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0"
          >
            <DialogPrimitive.Title className="sr-only">Jump to item</DialogPrimitive.Title>
            <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
              <Search className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setHighlighted(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setHighlighted((i) => Math.min(i + 1, filtered.length - 1));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setHighlighted((i) => Math.max(i - 1, 0));
                  } else if (e.key === "Enter") {
                    e.preventDefault();
                    go(filtered[activeIndex]);
                  }
                }}
                placeholder="Search by id or title…"
                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
              <span className="shrink-0 border border-border px-1 font-mono text-[10.5px] text-muted-foreground">ESC</span>
            </div>
            <div className="max-h-[50vh] overflow-y-auto">
              {filtered.length === 0 ? (
                <p className="px-3 py-4 text-[13.5px] text-muted-foreground">{loading ? "Loading…" : "No matches."}</p>
              ) : (
                filtered.map((item, i) => (
                  <button
                    key={item.href}
                    type="button"
                    onMouseEnter={() => setHighlighted(i)}
                    onClick={() => go(item)}
                    className={cn(
                      "flex w-full items-center gap-3 border-b border-foreground/9 px-3 py-2 text-left text-[13.5px] last:border-0",
                      i === activeIndex && "bg-primary/8",
                    )}
                  >
                    <span className="shrink-0 font-mono text-xs font-medium text-foreground">{item.displayId}</span>
                    <span className="min-w-0 flex-1 truncate">{item.title}</span>
                    <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground uppercase">{item.kind}</span>
                  </button>
                ))
              )}
            </div>
          </DialogPrimitive.Popup>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  );
}
