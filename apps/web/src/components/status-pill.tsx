import { Badge } from "@/components/ui/badge";

const VARIANT_BY_CATEGORY: Record<string, "secondary" | "warning" | "success" | "info"> = {
  draft: "secondary",
  in_review: "warning",
  approved: "success",
  baselined: "info",
};

export function StatusPill({ category, name }: { category: string; name: string }) {
  return <Badge variant={VARIANT_BY_CATEGORY[category] ?? "secondary"}>{name}</Badge>;
}
