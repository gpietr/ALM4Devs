import type { ReactNode } from "react";
import { cn } from "cn";

/** The "blueprint" registration-mark frame from the shell-restructure design handoff -
 * four 11px `+` crosshairs, offset outside each corner, on top of a plain hairline
 * border. Applied to exactly one thing per the handoff: the main table panel on a list
 * screen - "dropping them from a framed element or adding them everywhere both break the
 * language," so this is deliberately not reached for anywhere else. Pure CSS, no image
 * asset: each corner is a small absolutely-positioned box whose ::before/::after draw the
 * cross as two 1px lines. */
export function Frame({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("relative border border-border", className)}>
      <Corner position="top-[-6px] left-[-6px]" />
      <Corner position="top-[-6px] right-[-6px]" />
      <Corner position="bottom-[-6px] left-[-6px]" />
      <Corner position="bottom-[-6px] right-[-6px]" />
      {children}
    </div>
  );
}

function Corner({ position }: { position: string }) {
  return (
    <i
      aria-hidden
      className={cn(
        "pointer-events-none absolute size-[11px] text-foreground/55",
        "before:absolute before:top-0 before:left-[5px] before:h-full before:w-px before:bg-current",
        "after:absolute after:top-[5px] after:left-0 after:h-px after:w-full after:bg-current",
        position,
      )}
    />
  );
}
