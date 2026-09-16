/** Shared by every "import all" loop in this package (requirements, test cases): the page
 * size used when paging through a Spira project, and a safety cap against a runaway loop
 * on an unexpectedly huge or misbehaving project - not a normal-path limit. */
export const SPIRA_IMPORT_PAGE_SIZE = 100;
export const SPIRA_IMPORT_MAX_ROWS_DEFAULT = 20_000;

/** How many rows the import UI asks for per chunked run call, so it can show live "x/n
 * processed" progress (backlog item 9.26) instead of one long silent request - small
 * enough that a browser sees a response every few seconds even on a slow Spira instance,
 * large enough not to spend most of the time on request overhead for a small project. */
export const SPIRA_IMPORT_PROGRESS_CHUNK_SIZE = 20;

/** Counts how many rows a paged Spira listing actually has, up to `maxRows` - the same
 * page-until-short-page loop every "import all" function already uses, but discarding the
 * rows instead of processing them. Used to show an honest "x/n" denominator before a real
 * run starts: `n` this returns is exactly how many rows the real run (capped at the same
 * `maxRows`) will actually attempt, not just "however many Spira happens to have". */
export async function countPagedRows(
  fetchPage: (params: { startRow: number; numberOfRows: number }) => Promise<unknown[]>,
  maxRows: number,
): Promise<number> {
  let total = 0;
  let startRow = 1;
  while (total < maxRows) {
    const page = await fetchPage({ startRow, numberOfRows: SPIRA_IMPORT_PAGE_SIZE });
    total += page.length;
    if (page.length < SPIRA_IMPORT_PAGE_SIZE) break;
    startRow += SPIRA_IMPORT_PAGE_SIZE;
  }
  return Math.min(total, maxRows);
}
