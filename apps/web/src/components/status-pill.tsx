import { cn } from "cn";

/** Status is coded by *form* (fill/outline/ink), not a traffic-light palette, so a
 * printed submission packet still reads correctly in greyscale - see the shell-
 * restructure design handoff's Color/Status table. Each category gets a genuinely
 * different shape, not just a different color, which is why this renders its own
 * classes directly rather than going through Badge's single variant shape. */
const CLASS_BY_CATEGORY: Record<string, string> = {
  draft: "border border-border text-muted-foreground",
  in_review: "border border-primary text-accent-tint-foreground",
  approved: "bg-accent-tint text-accent-tint-foreground",
  baselined: "bg-accent-deep text-background",
};

export function StatusPill({ category, name }: { category: string; name: string }) {
  return (
    <span
      className={cn(
        "inline-block px-1.5 py-px font-mono text-[11.5px] font-medium tracking-[0.04em] uppercase",
        CLASS_BY_CATEGORY[category] ?? CLASS_BY_CATEGORY.draft,
      )}
    >
      {name}
    </span>
  );
}
