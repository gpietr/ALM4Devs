/**
 * Pulls a positive integer out of an arbitrary legacy-id field value (e.g. a custom "ID"
 * field in Spira the team used before switching to this system), so it can be claimed as
 * this item's own local sequence number instead of always auto-assigning the next one -
 * see RequirementFieldMapping.legacyId/TestCaseFieldMapping.legacyId and
 * createRequirement/createTestCase's requestedSequenceNumber param.
 *
 * Handles a bare number ("104") or a number with a prefix ("SYS-104", "REQ_104",
 * "REQ104") by taking the LAST run of digits in the string, not the first - so a
 * year-prefixed value like "2024-104" still yields 104, not 2024, matching the
 * conventional "prefix then number" shape these fields tend to have. This is a heuristic,
 * not a real parser for every possible legacy scheme: a field whose convention puts the
 * number first (e.g. "104-A") would misparse. If that turns out to matter for a real
 * import, this is the one place to adjust.
 */
export function parseLegacySequenceNumber(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const matches = raw.match(/\d+/g);
  if (!matches || matches.length === 0) return null;
  const numberPart = matches[matches.length - 1]!;
  const n = Number(numberPart);
  if (!Number.isSafeInteger(n) || n <= 0 || n > 1_000_000_000) return null;
  return n;
}
