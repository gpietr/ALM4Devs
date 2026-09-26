"use client";

import { entryHref, type Entry, isEntry } from "./product-nav";

const KEY = "alm4devs:lastLocation";

export interface LastLocation {
  productId: string;
  entry: Entry;
  /** null for entries without a level rail; "all" for OTS's ALL cell. */
  levelId: string | null;
}

/**
 * Remembers only the high-level "where was I" - which product, which menu entry, which
 * level - not anything deeper (a specific requirement, a filter, a scroll position).
 * Plain `localStorage`, not a backend column: this is a per-device convenience, not data
 * anyone else needs to see or that should survive a device switch.
 */
export function saveLastLocation(location: LastLocation): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(location));
  } catch {
    // Private browsing / storage disabled - not remembering the last location is a fine
    // degradation, not worth surfacing to the user.
  }
}

export function getLastLocation(): LastLocation | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { productId?: unknown; entry?: unknown; levelId?: unknown };
    if (typeof parsed.productId !== "string" || typeof parsed.entry !== "string" || !isEntry(parsed.entry)) return null;
    return { productId: parsed.productId, entry: parsed.entry, levelId: typeof parsed.levelId === "string" ? parsed.levelId : null };
  } catch {
    return null;
  }
}

/** The URL a saved location resolves to. */
export function lastLocationHref(location: LastLocation): string {
  return entryHref(location.productId, location.entry, { level: location.levelId });
}
