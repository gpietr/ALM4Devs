"use client";

import { parseColumnParam, serializeColumnParam, type ListColumn } from "@/lib/column-visibility";
import { useUrlState } from "@/lib/use-url-state";
import { useEffect, useState } from "react";

const KEY = "alm4devs:listPreferences";

interface StoredPreferences {
  /** Same serialized form as the `columns` URL param (see column-visibility.ts) -
   * `undefined` here means "matches the default set", not "unset". */
  columns?: string;
  sortBy?: string;
  sortDir?: "asc" | "desc";
}

function readAll(): Record<string, StoredPreferences> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, StoredPreferences>) : {};
  } catch {
    return {};
  }
}

function writeOne(listId: string, patch: StoredPreferences): void {
  try {
    const all = readAll();
    // `patch`'s `undefined` values overwrite (not skip) the existing key, so picking
    // "default" columns again actually clears a previously-remembered override rather
    // than leaving the stale one in place - JSON.stringify drops the key entirely.
    all[listId] = { ...all[listId], ...patch };
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // Private browsing / storage disabled - not remembering is a fine degradation, same
    // as every other localStorage-backed preference in this app (see last-level.ts).
  }
}

/**
 * Column visibility and sort order, remembered per device across visits to a list - not
 * synced anywhere, same per-device/localStorage-only convention as last-level.ts's
 * remembered level. `listId` is a stable identifier for the list itself (e.g.
 * "requirements", "testCases"), shared across every product/level a user visits, since
 * "I always want the Versions column" is a preference about the list, not about one
 * product's data.
 *
 * The URL still wins whenever it names `columns`/`sortBy`/`sortDir` explicitly - a
 * shared or bookmarked link keeps showing exactly what it says. This only supplies what
 * a *bare* URL (no such params) falls back to, in place of the list's hardcoded default.
 */
export function useRememberedListState(listId: string, columns: ListColumn[]) {
  const { searchParams, setParams } = useUrlState();

  // Read in an effect, not during render - localStorage is unavailable during SSR (see
  // products/[id]/page.tsx's identical note on remembered levels). Starts null, so the
  // first render still falls through to each list's own hardcoded default, same as
  // before this existed.
  const [remembered, setRemembered] = useState<StoredPreferences | null>(null);
  useEffect(() => {
    setRemembered(readAll()[listId] ?? {});
  }, [listId]);

  const columnsParam = searchParams.get("columns") ?? remembered?.columns ?? null;
  const columnIds = parseColumnParam(columnsParam, columns);

  const sortBy = searchParams.get("sortBy") ?? remembered?.sortBy ?? null;
  const sortDir: "asc" | "desc" = (searchParams.get("sortDir") ?? remembered?.sortDir) === "desc" ? "desc" : "asc";

  function setColumns(ids: string[]) {
    const serialized = serializeColumnParam(ids, columns);
    setParams({ columns: serialized });
    writeOne(listId, { columns: serialized });
  }

  function onSort(key: string) {
    const nextDir: "asc" | "desc" = sortBy === key && sortDir === "asc" ? "desc" : "asc";
    // "asc" stays implicit in the URL (existing convention - only "desc" is written
    // explicitly), but the remembered copy stores the resolved value either way, so
    // "sorted by X ascending" is still what a bare visit falls back to.
    setParams({ sortBy: key, sortDir: nextDir === "asc" ? undefined : nextDir });
    writeOne(listId, { sortBy: key, sortDir: nextDir });
  }

  return { columnIds, sortBy, sortDir, setColumns, onSort };
}
