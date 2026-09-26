"use client";

/** Product navigation: three modes (row 1), each with a menu of entries (row 2). Every
 * entry lives at `/products/[id]/<mode>/<entry>`, so the mode comes from the route. */
export type Mode = "req" | "tests" | "tech";

export type Entry = "requirements" | "traceability" | "testCases" | "testSets" | "architecture" | "ots" | "versions";

interface EntryDef {
  mode: Mode;
  label: string;
  segment: string;
  /** Which level list the row-2 LEVEL rail shows for this entry, if any. */
  levels: "requirements" | "tests" | "architecture" | null;
}

export const ENTRIES: Record<Entry, EntryDef> = {
  requirements: { mode: "req", label: "Requirements", segment: "requirements", levels: "requirements" },
  traceability: { mode: "req", label: "Traceability", segment: "traceability", levels: null },
  testCases: { mode: "tests", label: "Test cases", segment: "test-cases", levels: "tests" },
  testSets: { mode: "tests", label: "Test sets", segment: "test-sets", levels: null },
  architecture: { mode: "tech", label: "Architecture", segment: "architecture", levels: "architecture" },
  ots: { mode: "tech", label: "OTS", segment: "ots", levels: "architecture" },
  versions: { mode: "tech", label: "Versions", segment: "versions", levels: null },
};

export const MODES: ReadonlyArray<{ key: Mode; label: string; entries: Entry[] }> = [
  { key: "req", label: "Requirements", entries: ["requirements", "traceability"] },
  { key: "tests", label: "Tests", entries: ["testCases", "testSets"] },
  { key: "tech", label: "Technical documentation", entries: ["architecture", "ots", "versions"] },
];

/** OTS's extra rail cell: every level at once. */
export const ALL_LEVELS = "all";

export function isEntry(value: string | null | undefined): value is Entry {
  return !!value && Object.hasOwn(ENTRIES, value);
}

/** An entry's URL; empty params are dropped. */
export function entryHref(
  productId: string,
  entry: Entry,
  params: Record<string, string | null | undefined> = {},
  subPath?: string,
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) query.set(key, value);
  const qs = query.toString();
  const def = ENTRIES[entry];
  return `/products/${productId}/${def.mode}/${def.segment}${subPath ? `/${subPath}` : ""}${qs ? `?${qs}` : ""}`;
}

export function architectureNodeHref(productId: string, nodeId: string, params: Record<string, string | null | undefined> = {}) {
  return entryHref(productId, "architecture", params, nodeId);
}

export function otsItemHref(productId: string, nodeId: string, params: Record<string, string | null | undefined> = {}) {
  return entryHref(productId, "ots", params, nodeId);
}

// Last menu entry per mode (per device).

const ENTRY_KEY = "alm4devs:lastEntryByMode";

export function saveLastEntry(productId: string, entry: Entry): void {
  writeMap(ENTRY_KEY, `${productId}:${ENTRIES[entry].mode}`, entry);
}

export function getLastEntry(productId: string, mode: Mode): Entry | null {
  const value = readMap(ENTRY_KEY)[`${productId}:${mode}`];
  return isEntry(value) && ENTRIES[value].mode === mode ? value : null;
}

function writeMap(key: string, field: string, value: string): void {
  try {
    const map = readMap(key);
    map[field] = value;
    localStorage.setItem(key, JSON.stringify(map));
  } catch {
    // Private browsing / storage disabled - not remembering is a fine degradation.
  }
}

function readMap(key: string): Record<string, string> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}
