/**
 * Shared parse/serialize for the list/matrix column pickers. Visible columns live in
 * the URL (`?columns=id,title,...`) the same way sort/filter do (see use-url-state.ts),
 * so a chosen set is a shareable link rather than per-viewer local state.
 *
 * `columns` is the *full* visible set - built-in columns and tenant-defined fields
 * together, not an opt-in list of extras on top of a hardcoded table. Absent from the
 * URL means "whatever each column's defaultVisible says" (built-ins on, most extra
 * fields off unless a column opts in). `none` means hide everything except columns
 * marked `required` - at least one column with a link into the underlying item (e.g.
 * "id" or "title") should always be marked required, or a filtered-to-nothing view has
 * no way to open a row.
 */

export type ListColumn = {
  id: string;
  label: string;
  /** Shown when the URL has no `columns` param. Defaults to true. */
  defaultVisible?: boolean;
  /** Structural column (e.g. the row's own id/title link) that a caller must not be able
   * to hide entirely - without at least one, a filtered-to-empty result has no way to open
   * the underlying item. Always included by parseColumnParam/defaultVisibleIds regardless
   * of the URL, and toggleColumnId refuses to remove it. */
  required?: boolean;
};

function requiredIds(columns: ListColumn[]): string[] {
  return columns.filter((c) => c.required).map((c) => c.id);
}

export function defaultVisibleIds(columns: ListColumn[]): string[] {
  const ids = columns.filter((c) => c.required || c.defaultVisible !== false).map((c) => c.id);
  return ids;
}

export function parseColumnParam(raw: string | null, columns: ListColumn[]): string[] {
  const defaults = defaultVisibleIds(columns);
  if (raw === null) return defaults;
  const required = requiredIds(columns);
  if (raw === "none") return required;
  const known = new Set(columns.map((c) => c.id));
  const ids = raw.split(",").filter((id) => known.has(id));
  const missingRequired = required.filter((id) => !ids.includes(id));
  return missingRequired.length > 0 ? [...ids, ...missingRequired] : ids;
}

/** `undefined` when the selection matches the default, so the URL stays clean. "none"
 * means the minimum reachable state (just the required columns, if any - "hide
 * everything" when there are none), matching what parseColumnParam("none", ...) parses
 * back to. */
export function serializeColumnParam(ids: string[], columns: ListColumn[]): string | undefined {
  const required = requiredIds(columns);
  const normalized = ids.length === 0 ? required : ids;
  if (normalized.length === required.length && required.every((id) => normalized.includes(id))) {
    return "none";
  }
  const defaults = defaultVisibleIds(columns);
  if (normalized.length === defaults.length && defaults.every((id) => normalized.includes(id))) return undefined;
  return normalized.join(",");
}

export function toggleColumnId(ids: string[], id: string, columns: ListColumn[]): string[] {
  if (columns.find((c) => c.id === id)?.required) return ids;
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}
