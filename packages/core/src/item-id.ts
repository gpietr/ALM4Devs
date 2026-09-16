/**
 * The human-readable id shown everywhere a requirement or test case appears (e.g.
 * "SYSREQ-1") - a level's `code` (see packages/db/src/schema.ts's `levels` table) glued
 * to that item's `sequenceNumber` with a hyphen. Computed here, not stored, so it always
 * reflects the level's *current* code while the number itself never changes once
 * assigned - see requirements.sequenceNumber's schema comment for the storage side of
 * this. Lives in packages/core (not apps/web) so anything outside the web app - the
 * traceability PDF/CSV export, a future worker job, a future public API - can format or
 * parse the same id without depending on the Next.js app.
 */
export function formatItemId(code: string, sequenceNumber: number): string {
  return `${code}-${sequenceNumber}`;
}

const ITEM_ID_PATTERN = /^([A-Z0-9]+)-(\d+)$/;

/** The inverse of formatItemId: splits a pasted/typed id like "SYSREQ-12" back into its
 * code and sequence number, or returns null if it doesn't match the shape formatItemId
 * produces (e.g. free text typed into a search box). Codes are always uppercase
 * alphanumeric (see normalizeLevelCode), so the pattern is unambiguous - there's no
 * hyphen inside a code to confuse the split. Does NOT verify the code/number actually
 * exist; callers that need a real item still have to look one up. */
export function parseItemId(raw: string): { code: string; sequenceNumber: number } | null {
  const match = ITEM_ID_PATTERN.exec(raw.trim().toUpperCase());
  if (!match) return null;
  const [, code, numberPart] = match;
  const sequenceNumber = Number(numberPart);
  if (!code || !Number.isSafeInteger(sequenceNumber) || sequenceNumber <= 0) return null;
  return { code, sequenceNumber };
}
