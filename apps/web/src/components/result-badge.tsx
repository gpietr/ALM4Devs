import { cn } from "cn";

/** Covers both step results (not_run/pass/fail/blocked) and execution rollups
 * (in_progress/pass/fail/blocked) - same vocabulary, one shared map instead of the two
 * independent ones this replaced (see TECH_STACK.md). Coded by form, not a traffic-light
 * palette, the same convention status-pill.tsx uses: fill = a real recorded outcome
 * (accent for pass, ink for fail - the same accent/ink pairing the coverage squares on
 * the requirements list use), outline = still pending, dashed = an exception state. */
const CLASS_BY_STATUS: Record<string, string> = {
  not_run: "border border-border text-muted-foreground",
  in_progress: "border border-primary text-accent-tint-foreground",
  pass: "bg-primary text-primary-foreground",
  fail: "bg-foreground text-background",
  blocked: "border border-dashed border-foreground/45 text-muted-foreground",
};

export function ResultBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-block px-1.5 py-px font-mono text-[11.5px] font-medium tracking-[0.04em] uppercase",
        CLASS_BY_STATUS[status] ?? CLASS_BY_STATUS.not_run,
      )}
    >
      {status.replaceAll("_", " ")}
    </span>
  );
}
