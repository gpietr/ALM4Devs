"use client";

import { useEffect } from "react";

/** App-wide registry of editors with unsaved edits, so navigation anywhere (shell,
 * workspace list, item tabs) can ask first. Module-level rather than context: the shell
 * and editors live in different layouts/pages. */
const dirtySources = new Set<string>();

const MESSAGE = "You have unsaved changes. Leave without saving?";

/** Registers `source` while `dirty`, including the browser's beforeunload prompt. */
export function useUnsavedChanges(source: string, dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;
    dirtySources.add(source);
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      dirtySources.delete(source);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [source, dirty]);
}

// Suppresses a second prompt within the same task after a "yes". The registry itself is
// not cleared: an editor can stay mounted after a "yes" (query-only URL change, cancelled
// delete) and must stay protected.
let justConfirmed = false;

/** Asks before discarding unsaved edits; true means "go ahead". */
export function confirmDiscardChanges(): boolean {
  if (dirtySources.size === 0 || justConfirmed) return true;
  if (!window.confirm(MESSAGE)) return false;
  justConfirmed = true;
  setTimeout(() => {
    justConfirmed = false;
  }, 0);
  return true;
}

/** onClick for a <Link> that should respect the guard. */
export function guardLinkClick(e: { preventDefault: () => void }): void {
  if (!confirmDiscardChanges()) e.preventDefault();
}
