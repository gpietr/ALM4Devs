"use client";

import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import type { FilterDef } from "@/lib/list-filters";

const ANY = "any";

/**
 * One filter as a "Label: Value" chip - a Select restyled as the handoff's filter
 * affordance (tinted border/fill once a value is picked), generalized from
 * requirements-section.tsx's original private `FilterSelect` so every artefact list can
 * render a `FilterDef` (see list-filters.ts) the same way instead of each list hand-
 * rolling its own. Looks the option's *label* up from `def.options` rather than assuming
 * the stored value is already display text - the version filter's value is a software-
 * version id, not its version number.
 */
export function FilterChip<Row>({
  def,
  value,
  onChange,
}: {
  def: FilterDef<Row>;
  value: string | undefined;
  onChange: (value: string | undefined) => void;
}) {
  const active = value !== undefined;
  const activeLabel = active ? def.options.find((o) => o.value === value)?.label ?? value : "All";

  return (
    <Select value={value ?? ANY} onValueChange={(v) => onChange(v === ANY ? undefined : (v ?? undefined))}>
      <SelectTrigger
        className={
          active
            ? "gap-1.5 border-primary bg-[rgba(89,128,166,.12)] px-2.5 py-[5px] text-sm text-[#2c455d]"
            : "gap-1.5 border-border bg-card px-2.5 py-[5px] text-sm text-muted-foreground"
        }
      >
        <span>
          {def.label}: <span className={active ? "font-medium" : "font-medium text-foreground"}>{activeLabel}</span>
        </span>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ANY}>All</SelectItem>
        {def.options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
