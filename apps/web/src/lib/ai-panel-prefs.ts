"use client";

const KEY = "galm:aiToolsPanel";

export interface AiPanelPrefs {
  open: boolean;
  width: number;
}

/**
 * Remembers whether the AI tools panel was left open and how wide the user dragged it -
 * a per-device UI convenience, not data anyone else needs to see, so plain `localStorage`
 * rather than a backend column. Same pattern as last-location.ts/last-level.ts.
 */
export function saveAiPanelPrefs(prefs: AiPanelPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Private browsing / storage disabled - not remembering is a fine degradation.
  }
}

export function getAiPanelPrefs(): AiPanelPrefs | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AiPanelPrefs>;
    if (typeof parsed.open !== "boolean" || typeof parsed.width !== "number") return null;
    return { open: parsed.open, width: parsed.width };
  } catch {
    return null;
  }
}
