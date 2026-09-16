"use client";

import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import Link from "next/link";
import { useCallback, useState } from "react";

/**
 * Shared by every /settings/import/* screen (the connection hub plus the requirements and
 * test-cases import screens - see that directory's layout.tsx for why they're separate
 * routes rather than one long page): the field-mapping dropdown, the connection-status
 * note each sub-screen shows instead of re-rendering the whole connection form, and the
 * import-result row helpers common to both the requirement and test-case result lists.
 */

const NONE = "__none__";

export function MappingSelect({
  label,
  value,
  onChange,
  fields,
  allowNone,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  fields: Array<{ key: string; label: string }>;
  allowNone: boolean;
}) {
  return (
    <Label className="flex-col items-start gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <Select value={allowNone ? value || NONE : value} onValueChange={(v) => onChange(v === NONE ? "" : (v ?? ""))}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder={allowNone ? "— none —" : "Select a field"} />
        </SelectTrigger>
        <SelectContent>
          {allowNone && <SelectItem value={NONE}>— none —</SelectItem>}
          {fields.map((f) => (
            <SelectItem key={f.key} value={f.key}>
              {f.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Label>
  );
}

/** Each import screen only needs to know whether a connection is saved, not edit it - the
 * full form lives on the hub page (/settings/import) alone, so it's the one place a saved
 * connection can get out of sync with what's displayed. */
export function ConnectionStatusNote({
  connection,
}: {
  connection: { data?: { projectId: number; username: string } | null; isLoading: boolean };
}) {
  if (connection.isLoading) return null;
  if (!connection.data) {
    return (
      <p className="text-sm text-destructive">
        No Spira connection saved yet.{" "}
        <Link href="/settings/import" className="underline underline-offset-2">
          Set one up first
        </Link>
        .
      </p>
    );
  }
  return (
    <p className="text-xs text-muted-foreground">
      Connected to Spira project {connection.data.projectId} as {connection.data.username}.{" "}
      <Link href="/settings/import" className="underline underline-offset-2">
        Change connection
      </Link>
    </p>
  );
}

/** Shared by both result lists (requirements and test cases) - both row shapes carry
 * spiraId/title/action/note/error even though their other fields differ. */
export interface ImportResultRow {
  spiraId: number;
  title: string;
  action?: "created" | "updated" | "unchanged" | "skipped";
  note?: string;
  error?: string;
}

export function actionCount(rows: ImportResultRow[], action: NonNullable<ImportResultRow["action"]>): number {
  return rows.filter((r) => r.action === action).length;
}

export function actionClassName(action: ImportResultRow["action"]): string {
  switch (action) {
    case "created":
      return "text-emerald-700";
    case "updated":
      return "text-blue-700";
    case "skipped":
      return "text-amber-700";
    default:
      return "text-muted-foreground";
  }
}

export function resultLabel(row: ImportResultRow): string {
  if (row.error) return row.error;
  // "created" can still carry a note - e.g. a requested legacy id that was already taken
  // locally, so a different number got assigned instead (see legacyId's mapping option).
  if (row.action === "created") return `created${row.note ? ` (${row.note})` : ""}`;
  if (row.action === "updated") return `updated${row.note ? ` (${row.note})` : ""}`;
  if (row.action === "unchanged") return "unchanged since last import";
  if (row.action === "skipped") return `skipped${row.note ? ` - ${row.note}` : ""}`;
  return "imported";
}

/** How many rows one chunked run call asks for - small enough that the browser gets a
 * response (and can update "x/n processed") every few seconds even on a slow Spira
 * instance, large enough not to spend most of the time on request overhead for a small
 * project. See useChunkedSpiraImport below (backlog item 9.26). */
export const SPIRA_IMPORT_CHUNK_SIZE = 20;

export interface ChunkedImportRunOptions<TRow> {
  /** Called repeatedly with an advancing startRow and a fixed maxRows (SPIRA_IMPORT_CHUNK_SIZE)
   * until it returns fewer rows than that - each call is one tRPC round trip, which is
   * what makes incremental progress visible instead of one long blocking request. */
  fetchChunk: (startRow: number, maxRows: number) => Promise<TRow[]>;
  /** Best-effort total for the "x/n" denominator - a failure here doesn't stop the run,
   * `total` just stays null and the UI falls back to an open-ended "x processed" count. */
  fetchTotal?: () => Promise<number>;
  startRow: number;
  /** Set true for the legacy-id-preserving import mode (see either page's Legacy ID
   * mapping): that mode fetches every row up front and always starts over at row 1 - it
   * has no notion of "resume from startRow" or "just this chunk" to begin with (see
   * runOrderedSpiraImport/runOrderedSpiraTestCaseImport's docstrings), so chunking it
   * would silently just reprocess the same first `SPIRA_IMPORT_CHUNK_SIZE` rows forever
   * instead of ever reaching the rest. When true, `fetchChunk` is called exactly once,
   * with `maxRows` left unset (whole run in one call) - progress shows as indeterminate,
   * not "x/n". */
  unchunked?: boolean;
}

/** Drives one of the two Spira import mutations through a sequence of small chunks so the
 * screen can show live "x/n processed" progress (backlog item 9.26) instead of going
 * silent for the whole run. Deliberately not built on the mutation's own
 * isPending/data/error - those reflect only the *last* chunk call, not the accumulated
 * state of the whole multi-call run this hook is driving. */
export function useChunkedSpiraImport<TRow>() {
  const [rows, setRows] = useState<TRow[]>([]);
  const [processed, setProcessed] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasRun, setHasRun] = useState(false);

  const run = useCallback(async (options: ChunkedImportRunOptions<TRow>) => {
    setRows([]);
    setProcessed(0);
    setTotal(null);
    setError(null);
    setIsRunning(true);
    setHasRun(true);
    try {
      if (options.fetchTotal) {
        try {
          setTotal(await options.fetchTotal());
        } catch {
          // Best-effort only - an honest denominator is a nicety, not something the run
          // itself depends on.
        }
      }
      if (options.unchunked) {
        const chunk = await options.fetchChunk(options.startRow, SPIRA_IMPORT_MAX_ROWS_HINT);
        setRows(chunk);
        setProcessed(chunk.length);
        return;
      }
      let startRow = options.startRow;
      let processedSoFar = 0;
      for (;;) {
        const chunk = await options.fetchChunk(startRow, SPIRA_IMPORT_CHUNK_SIZE);
        setRows((prev) => [...prev, ...chunk]);
        processedSoFar += chunk.length;
        startRow += chunk.length;
        setProcessed(processedSoFar);
        if (chunk.length < SPIRA_IMPORT_CHUNK_SIZE) break;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "import failed");
    } finally {
      setIsRunning(false);
    }
  }, []);

  return { rows, processed, total, isRunning, error, hasRun, run };
}

/** Passed as `maxRows` for the unchunked (legacy-id) path - large enough to mean "the
 * whole project" without hardcoding the server's own default here. */
const SPIRA_IMPORT_MAX_ROWS_HINT = 20_000;
