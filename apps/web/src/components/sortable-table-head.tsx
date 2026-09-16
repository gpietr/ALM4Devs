"use client";

import { TableHead } from "@/components/ui/table";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";

/** A clickable TableHead that toggles sort direction on the active column and switches to
 * ascending on any other column - the standard spreadsheet/table convention. Used by every
 * table with customizable sorting (requirements, test cases, the traceability matrix);
 * sort state itself lives in the URL (see use-url-state.ts) so a sorted view is a
 * shareable link, not local-only state. */
export function SortableTableHead({
  label,
  sortKey,
  activeSortKey,
  direction,
  onSort,
  className,
}: {
  label: string;
  sortKey: string;
  activeSortKey: string | null;
  direction: "asc" | "desc";
  onSort: (key: string) => void;
  className?: string;
}) {
  const active = activeSortKey === sortKey;
  return (
    <TableHead className={className}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className="flex items-center gap-1 hover:text-foreground"
      >
        {label}
        {active ? (
          direction === "asc" ? (
            <ArrowUp className="size-3" />
          ) : (
            <ArrowDown className="size-3" />
          )
        ) : (
          <ArrowUpDown className="size-3 text-muted-foreground/40" />
        )}
      </button>
    </TableHead>
  );
}
