"use client";

import { useUrlState } from "@/lib/use-url-state";
import { useMemo } from "react";

/**
 * A small, declarative filter framework for the artefact list pages - one filter is just
 * an entry in an array (`FilterDef`), not a bespoke Select-plus-matching-logic block
 * copy-pasted per filter (see requirements-section.tsx's old private `FilterSelect`,
 * which this generalizes into filter-chip.tsx). Adding a second, third, ... filter to a
 * list is adding one more `FilterDef`, never a new component or a new place filtering
 * logic lives.
 *
 * Each filter is single-select for now (one value or "unset") - matches the UX every
 * existing filter in this app already has (status, coverage), and `matches` is a plain
 * per-row predicate so a future multi-select filter can still reuse this same shape
 * without changing it.
 */
export interface FilterOption {
  value: string;
  label: string;
}

export interface FilterDef<Row> {
  /** Also the URL param key this filter reads/writes (e.g. `?version=<uuid>`) - same
   * convention the existing `status`/`q`/`sortBy` params already use, so a filtered view
   * stays a plain, shareable link. */
  id: string;
  label: string;
  options: FilterOption[];
  matches: (row: Row, value: string) => boolean;
}

/** Reads/writes every `def`'s value from the URL and returns the pieces a list page's
 * render needs: `active` (current value per filter id, absent when unset), `setFilter`,
 * `clearAll`, `hasActive`, and `applyFilters` - narrows a row array by every filter that
 * currently has a value (AND across filters, same as every multi-filter list in this app
 * already behaves). */
export function useListFilters<Row>(defs: FilterDef<Row>[]) {
  const { searchParams, setParams } = useUrlState();

  const active = useMemo(() => {
    const result: Record<string, string> = {};
    for (const def of defs) {
      const value = searchParams.get(def.id);
      if (value) result[def.id] = value;
    }
    return result;
    // defs is expected to be a stable (or memoized) array from the caller; keying off
    // searchParams.toString() avoids re-deriving `active` on every unrelated param change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams.toString(), defs]);

  function setFilter(id: string, value: string | undefined) {
    setParams({ [id]: value });
  }

  function clearAll() {
    setParams(Object.fromEntries(defs.map((def) => [def.id, undefined])));
  }

  function applyFilters(rows: Row[]): Row[] {
    const withValues = defs.filter((def) => active[def.id]);
    if (withValues.length === 0) return rows;
    return rows.filter((row) => withValues.every((def) => def.matches(row, active[def.id]!)));
  }

  return { active, setFilter, clearAll, applyFilters, hasActive: Object.keys(active).length > 0 };
}
