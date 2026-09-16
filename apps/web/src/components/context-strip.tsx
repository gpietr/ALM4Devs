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
import { trpc } from "@/lib/trpc-client";
import { ChevronDown, Settings } from "lucide-react";
import Link from "next/link";
import { SignOutButton } from "./sign-out-button";

/**
 * Persistent, deliberately quiet top bar - see the "Galm Navigation Blueprint" review
 * artifact this implements. One line, no border-heavy tab styling: it's background
 * information you register while working, not a nav bar you look for. `TopBar` is the
 * shell every authenticated page renders (its own top element, not a shared layout slot -
 * simpler than threading page-specific content through a Next.js layout);
 * `ProductContextStrip` builds the left-hand content for pages scoped to one product.
 *
 * The three dropdowns (product switcher, level picker, avatar menu) were originally plain
 * `<details>`/`<summary>` - functional, but no real keyboard nav, no managed focus, and
 * `<details>`'s built-in disclosure triangle only strips cleanly in Chromium. Now backed by
 * shadcn's DropdownMenu (Base UI underneath) for the same reason EsignModal moved to
 * Dialog - real accessibility primitives instead of hand-rolled ones.
 */
export function TopBar({ left }: { left?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-b bg-background px-4 py-2 text-sm">
      {/* `min-w-0` is load-bearing - a flex item won't shrink below its content's
          natural width by default, so without it this row's several items push the
          whole page wider than the viewport on narrow screens. `overflow-x-auto` lets
          this row scroll internally instead, if it still doesn't fit. */}
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">{left}</div>
      {/* `shrink-0` so the avatar/settings icons stay reachable, never squeezed by the
          now-scrollable content beside them. */}
      <div className="flex shrink-0 items-center gap-2">
        <UserCorner />
      </div>
    </div>
  );
}

function UserCorner() {
  const session = authClient.useSession();
  const user = session.data?.user as { name?: string; email?: string } | undefined;
  const initials = initialsFor(user?.name, user?.email);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
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
          <DropdownMenuSeparator />
          <div className="px-1.5 py-1">
            <SignOutButton />
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
      <Link
        href="/settings"
        title="Settings"
        className="flex h-7 w-7 items-center justify-center rounded-md border text-muted-foreground hover:bg-muted"
      >
        <Settings className="size-4" />
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

type Artifact = "requirements" | "testCases" | "traceability";

/** The left-hand content for any page scoped to one product: a rarely-used product
 * switcher, the Requirements/Test Cases toggle (separate contexts - picking one swaps
 * which level set applies, never both at once), and the level dropdown for whichever is
 * active. `activeLevelId` may be null while data is loading - the trigger just shows a
 * placeholder until it resolves. */
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
  const testLevels = trpc.testCases.listLevels.useQuery();

  const productName = products.data?.find((p) => p.id === productId)?.name ?? "Product";
  // No level dropdown for the traceability tab - it deliberately spans every level at once.
  const levels = artifact === "requirements" ? requirementLevels.data : artifact === "testCases" ? testLevels.data : null;

  return (
    <TopBar
      left={
        <>
          <DropdownMenu>
            <DropdownMenuTrigger className="flex items-center gap-1 rounded-md px-2 py-1 font-medium text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">
              {productName}
              <ChevronDown className="size-3.5 text-muted-foreground" />
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

          <span className="text-muted-foreground/50">/</span>

          <div className="inline-flex rounded-md bg-muted p-0.5">
            <Link
              href={`/products/${productId}?artifact=requirements`}
              className={`rounded px-2.5 py-1 text-sm font-medium ${
                artifact === "requirements" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Requirements
            </Link>
            <Link
              href={`/products/${productId}?artifact=testCases`}
              className={`rounded px-2.5 py-1 text-sm font-medium ${
                artifact === "testCases" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Test Cases
            </Link>
            <Link
              href={`/products/${productId}?artifact=traceability`}
              className={`rounded px-2.5 py-1 text-sm font-medium ${
                artifact === "traceability" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Traceability
            </Link>
          </div>

          {levels && levels.length > 0 && (
            <>
              <span className="text-muted-foreground/50">/</span>
              <DropdownMenu>
                <DropdownMenuTrigger className="flex items-center gap-1 rounded-md px-2 py-1 font-medium text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">
                  {levels.find((l) => l.id === activeLevelId)?.name ?? "Level"}
                  <ChevronDown className="size-3.5 text-muted-foreground" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-56">
                  {levels.map((level) => (
                    <DropdownMenuItem
                      key={level.id}
                      render={<Link href={`/products/${productId}?artifact=${artifact}&level=${level.id}`} />}
                    >
                      {level.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}
        </>
      }
    />
  );
}
