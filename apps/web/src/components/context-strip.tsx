"use client";

import { authClient } from "@/lib/auth-client";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { JumpToItem } from "@/components/jump-to-item";
import { trpc } from "@/lib/trpc-client";
import { ChevronDown, Settings } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { SignOutButton } from "./sign-out-button";

/**
 * Two-row app shell (design_handoff_shell_restructure/README.md's "2a" proposal),
 * replacing the earlier single-line strip. `TopBar` is the shell every authenticated
 * page renders (its own top element, not a shared layout slot - simpler than threading
 * page-specific content through a Next.js layout): row 1 is identity/product/search/
 * user, always present; row 2 (artifact tabs + level rail) is product-scoped, so plain
 * pages (Settings, the product list) render `<TopBar />` with nothing else and get row 1
 * alone. `ProductContextStrip` builds both rows for a page scoped to one product.
 *
 * The dropdowns (product switcher, avatar menu) are shadcn's DropdownMenu (Base UI
 * underneath) for real keyboard nav/managed focus, not hand-rolled `<details>`.
 */
export function TopBar({
  productSwitcher,
  row2,
  productId = null,
}: {
  productSwitcher?: ReactNode;
  row2?: ReactNode;
  /** Scopes the "Jump to item" search below to one product - only `ProductContextStrip`
   * has one to give; plain pages (Settings, the product list, home) leave this null and
   * the search renders as a disabled affordance instead, same as it did before it was
   * wired up to anything. */
  productId?: string | null;
}) {
  return (
    <div className="border-b border-border bg-card">
      <div className="flex items-stretch">
        <Link
          href="/"
          className="flex items-center border-r border-border px-4 font-heading text-[15px] tracking-[0.08em] text-foreground hover:bg-muted/50"
          title="Home"
        >
          ALM4Devs
        </Link>
        {productSwitcher}
        <div className="flex-1" />
        <JumpToItem productId={productId} />
        <div className="flex items-center gap-2.5 border-l border-border px-3.5">
          <UserCorner />
        </div>
      </div>
      {row2}
    </div>
  );
}

function UserCorner() {
  const session = authClient.useSession();
  const user = session.data?.user as { name?: string; email?: string; isSystemAdmin?: boolean } | undefined;
  const initials = initialsFor(user?.name, user?.email);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          className="flex size-6 items-center justify-center bg-primary font-mono text-[11px] font-semibold text-primary-foreground outline-none"
          aria-label="Account menu"
        >
          {initials}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          {/* DropdownMenuLabel wraps Base UI's Menu.GroupLabel, which - unlike Radix's
              standalone DropdownMenuLabel - throws ("MenuGroupContext is missing") unless
              it's actually inside a Menu.Group. This was the real cause of "clicking my
              initials gives an error": the label was a direct child of DropdownMenuContent
              with no group wrapping it at all. */}
          <DropdownMenuGroup>
            <DropdownMenuLabel className="truncate font-normal text-muted-foreground">{user?.email}</DropdownMenuLabel>
          </DropdownMenuGroup>
          {user?.isSystemAdmin && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem render={<Link href="/admin" />}>System admin</DropdownMenuItem>
            </>
          )}
          <DropdownMenuSeparator />
          <div className="px-1.5 py-1">
            <SignOutButton />
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
      <Link href="/settings" title="Settings" className="flex text-muted-foreground hover:text-foreground">
        <Settings className="size-4" strokeWidth={1.5} />
      </Link>
    </>
  );
}

function initialsFor(name?: string, email?: string): string {
  if (name) {
    const parts = name.trim().split(/\s+/);
    return (parts[0]?.[0] ?? "").concat(parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "").toUpperCase();
  }
  return (email?.[0] ?? "?").toUpperCase();
}

type Artifact = "requirements" | "architecture" | "testCases" | "testSets" | "traceability" | "versions";

const ARTIFACT_TABS: ReadonlyArray<{ key: Artifact; label: string }> = [
  { key: "requirements", label: "Requirements" },
  { key: "testCases", label: "Test cases" },
  { key: "testSets", label: "Test sets" },
  { key: "traceability", label: "Traceability" },
  { key: "architecture", label: "Architecture" },
  { key: "versions", label: "Versions" },
];

/** Both rows for a page scoped to one product: row 1 adds the product switcher (a
 * rarely-used dropdown, per-tenant); row 2 is the artifact tabs plus, for whichever
 * artifact is active, that artifact's level rail (absent for traceability - it
 * deliberately spans every level at once). `activeLevelId` may be null while data is
 * loading - the active cell just doesn't highlight yet. */
export function ProductContextStrip({
  productId,
  artifact,
  activeLevelId,
}: {
  productId: string;
  artifact: Artifact;
  activeLevelId: string | null;
}) {
  const products = trpc.products.list.useQuery();
  const requirementLevels = trpc.requirements.listLevels.useQuery();
  const architectureLevels = trpc.architecture.listLevels.useQuery();
  const testLevels = trpc.testCases.listLevels.useQuery();

  const productName = products.data?.find((p) => p.id === productId)?.name ?? "Product";
  const levels =
    artifact === "requirements"
      ? requirementLevels.data
      : artifact === "architecture"
        ? architectureLevels.data
        : artifact === "testCases"
          ? testLevels.data
          : null;

  return (
    <TopBar
      productId={productId}
      productSwitcher={
        <DropdownMenu>
          <DropdownMenuTrigger className="flex items-center gap-2 border-r border-border px-4 outline-none">
            <span className="flex flex-col items-start leading-tight">
              <span className="font-mono text-[10.5px] tracking-[0.1em] text-muted-foreground">PRODUCT</span>
              <span className="text-[15px] font-medium text-foreground">{productName}</span>
            </span>
            <ChevronDown className="size-[13px] text-muted-foreground" strokeWidth={1.5} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            {products.data?.map((p) => (
              <DropdownMenuItem
                key={p.id}
                render={<Link href={`/products/${p.id}`} />}
                className={p.id === productId ? "bg-accent font-medium" : undefined}
              >
                {p.name}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem render={<Link href="/products" />} className="text-muted-foreground">
              All products
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      }
      row2={
        <div className="flex items-stretch justify-between border-b border-border bg-background">
          <div className="flex items-stretch">
            {ARTIFACT_TABS.map((tab) => (
              <Link
                key={tab.key}
                href={`/products/${productId}?artifact=${tab.key}`}
                className={`flex items-center border-b-2 px-4 font-heading text-[13.5px] tracking-[0.1em] uppercase ${
                  artifact === tab.key ? "border-primary text-foreground" : "border-transparent text-muted-foreground"
                }`}
              >
                {tab.label}
              </Link>
            ))}
          </div>
          {levels && levels.length > 0 && (
            <div className="flex items-center gap-2.5 py-1.5 pr-4">
              <span className="font-mono text-[10.5px] tracking-[0.1em] text-muted-foreground">LEVEL</span>
              <div className="flex">
                {levels.map((level) => (
                  <Link
                    key={level.id}
                    href={`/products/${productId}?artifact=${artifact}&level=${level.id}`}
                    className={`flex items-center border px-2.5 py-[3px] font-mono text-xs font-medium -ml-px first:ml-0 ${
                      level.id === activeLevelId
                        ? "z-10 border-primary bg-primary text-primary-foreground"
                        : "border-border text-muted-foreground"
                    }`}
                  >
                    {level.code}
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      }
    />
  );
}
