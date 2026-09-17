"use client";

const KEY = "alm4devs:lastLevelByArtifact";

type Artifact = "requirements" | "testCases";

/**
 * Remembers the last level viewed within each (product, artifact) pair, so switching tabs
 * (the context strip's Requirements/Test Cases links, which carry no `level` param) lands
 * back where you were instead of resetting to the first level. Separate from
 * `last-location.ts`'s single "most recent place overall" slot (for the home page's
 * redirect), which gets overwritten on every tab switch and so can't answer this same
 * question per artifact. Same per-device, `localStorage`-only convenience as that module.
 */
export function saveLastLevel(productId: string, artifact: Artifact, levelId: string): void {
  try {
    const map = readMap();
    map[`${productId}:${artifact}`] = levelId;
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    // Private browsing / storage disabled - not remembering is a fine degradation.
  }
}

export function getLastLevel(productId: string, artifact: Artifact): string | null {
  try {
    return readMap()[`${productId}:${artifact}`] ?? null;
  } catch {
    return null;
  }
}

function readMap(): Record<string, string> {
  const raw = localStorage.getItem(KEY);
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") return {};
  return parsed as Record<string, string>;
}
