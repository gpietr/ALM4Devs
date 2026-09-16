import { Badge } from "@/components/ui/badge";

/** Covers both step results (not_run/pass/fail/blocked) and execution rollups
 * (in_progress/pass/fail/blocked) - same vocabulary, one shared map instead of the two
 * independent ones this replaced (see TECH_STACK.md). */
const VARIANT_BY_STATUS: Record<string, "secondary" | "warning" | "success" | "destructive" | "info"> = {
  not_run: "secondary",
  in_progress: "warning",
  pass: "success",
  fail: "destructive",
  blocked: "info",
};

export function ResultBadge({ status }: { status: string }) {
  return <Badge variant={VARIANT_BY_STATUS[status] ?? "secondary"}>{status.replaceAll("_", " ")}</Badge>;
}
