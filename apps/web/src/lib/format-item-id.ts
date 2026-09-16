/**
 * Deliberately a standalone copy of packages/core/src/item-id.ts, not a re-export of it -
 * this file is imported from client components (e.g. list/detail pages), and @galm/core's
 * barrel (`index.ts`) unconditionally re-exports every domain module including
 * audit.ts/level-sequences.ts, which import `@galm/db`, which imports Bun's native `bun`
 * SQL client - a server-only module Next.js's webpack client build can't resolve. Tried
 * re-exporting from `@galm/core` directly; it broke the production build with exactly
 * that "Module not found: Can't resolve 'bun'" error, pulled in transitively through any
 * page that imports this file. Two genuinely independent copies of ~10 lines of pure,
 * dependency-free logic is a better trade than either threading a new
 * client-bundle-safe subpath export through packages/core's build, or re-introducing that
 * server-only dependency into the client bundle. Keep the two in sync if the format ever
 * changes - see the other copy for the full reasoning behind the format itself.
 */
export function formatItemId(code: string, sequenceNumber: number): string {
  return `${code}-${sequenceNumber}`;
}

const ITEM_ID_PATTERN = /^([A-Z0-9]+)-(\d+)$/;

export function parseItemId(raw: string): { code: string; sequenceNumber: number } | null {
  const match = ITEM_ID_PATTERN.exec(raw.trim().toUpperCase());
  if (!match) return null;
  const [, code, numberPart] = match;
  const sequenceNumber = Number(numberPart);
  if (!code || !Number.isSafeInteger(sequenceNumber) || sequenceNumber <= 0) return null;
  return { code, sequenceNumber };
}
