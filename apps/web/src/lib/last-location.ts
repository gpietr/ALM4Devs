"use client";

const KEY = "alm4devs:lastLocation";

export interface LastLocation {
  productId: string;
  artifact: "requirements" | "architecture" | "testCases" | "traceability" | "versions";
  /** null for traceability/versions, which both span every level at once - see products/[id]/page.tsx. */
  levelId: string | null;
}

/**
 * Remembers only the high-level "where was I" - which product, which artifact type,
 * which level - not anything deeper (a specific requirement, a filter, a scroll position).
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
    const parsed = JSON.parse(raw) as Partial<LastLocation>;
    if (typeof parsed.productId !== "string") return null;
    if (
      parsed.artifact !== "requirements" &&
      parsed.artifact !== "architecture" &&
      parsed.artifact !== "testCases" &&
      parsed.artifact !== "traceability" &&
      parsed.artifact !== "versions"
    ) {
      return null;
    }
    return { productId: parsed.productId, artifact: parsed.artifact, levelId: parsed.levelId ?? null };
  } catch {
    return null;
  }
}

/** The URL saveLastLocation's data resolves to - shared so the writer (products/[id]/page)
 * and reader (the home page redirect) can't drift apart on the format. */
export function lastLocationHref(location: LastLocation): string {
  const params = new URLSearchParams({ artifact: location.artifact });
  if (location.levelId) params.set("level", location.levelId);
  return `/products/${location.productId}?${params.toString()}`;
}
