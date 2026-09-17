/**
 * Shared parse/serialize for the list/matrix column pickers. Visible columns live in
 * the URL (`?columns=id,title,...`) the same way sort/filter do (see use-url-state.ts),
 * so a chosen set is a shareable link rather than per-viewer local state.
 *
 * `columns` is the *full* visible set - built-in columns and tenant-defined fields
 * together, not an opt-in list of extras on top of a hardcoded table. Absent from the
 * URL means "whatever each column's defaultVisible says" (built-ins on, most extra
 * fields off unless a column opts in). `none` means hide everything.
 */

export type ListColumn = {
  id: string;
  label: string;
  /** Shown when the URL has no `columns` param. Defaults to true. */
  defaultVisible?: boolean;
};

export function defaultVisibleIds(columns: ListColumn[]): string[] {
  return columns.filter((c) => c.defaultVisible !== false).map((c) => c.id);
}

export function parseColumnParam(raw: string | null, columns: ListColumn[]): string[] {
  const defaults = defaultVisibleIds(columns);
  if (raw === null) return defaults;
  if (raw === "none") return [];
  const known = new Set(columns.map((c) => c.id));
  return raw.split(",").filter((id) => known.has(id));
}

/** `undefined` when the selection matches the default, so the URL stays clean. */
export function serializeColumnParam(ids: string[], columns: ListColumn[]): string | undefined {
  if (ids.length === 0) return "none";
  const defaults = defaultVisibleIds(columns);
  if (ids.length === defaults.length && defaults.every((id) => ids.includes(id))) return undefined;
  return ids.join(",");
}

export function toggleColumnId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}
