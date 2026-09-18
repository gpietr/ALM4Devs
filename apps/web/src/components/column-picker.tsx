"use client";

import { Button, buttonVariants } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { type ListColumn, defaultVisibleIds, toggleColumnId } from "@/lib/column-visibility";
import { SlidersHorizontal } from "lucide-react";

/**
 * Popover checklist of which columns to show on a list/matrix table - built-in columns
 * and tenant-defined fields in one list, so the two aren't a different kind of column
 * from the user's point of view. `selectedIds` is owned by the caller (typically a URL
 * param via useUrlState). `onChange` receives the next full visible set, not a patch.
 */
export function ColumnPicker({
  columns,
  selectedIds,
  onChange,
}: {
  columns: ListColumn[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}) {
  if (columns.length === 0) return null;
  const defaults = defaultVisibleIds(columns);
  const isDefault =
    selectedIds.length === defaults.length && defaults.every((id) => selectedIds.includes(id));

  return (
    <Popover>
      <PopoverTrigger className={buttonVariants({ variant: "outline", size: "sm", className: "h-8 gap-1.5" })}>
        <SlidersHorizontal className="size-3.5" />
        Columns
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-2">
        <p className="px-1 pb-1.5 text-xs font-medium text-muted-foreground">Columns</p>
        <div className="space-y-0.5">
          {columns.map((c) => {
            const checked = c.required || selectedIds.includes(c.id);
            return (
              <label
                key={c.id}
                className={`flex items-center gap-2 rounded px-1.5 py-1 text-sm ${
                  c.required ? "text-muted-foreground" : "cursor-pointer hover:bg-muted"
                }`}
                title={c.required ? "Always shown" : undefined}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={c.required}
                  onChange={() => onChange(toggleColumnId(selectedIds, c.id, columns))}
                  className="size-3.5"
                />
                {c.label}
              </label>
            );
          })}
        </div>
        {!isDefault && (
          <Button variant="ghost" size="sm" className="mt-1 w-full" onClick={() => onChange(defaults)}>
            Reset
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}
