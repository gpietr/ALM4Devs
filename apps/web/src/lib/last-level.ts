"use client";

import type { Mode } from "./product-nav";

const KEY = "alm4devs:lastLevelByMode";

/**
 * Last level per (product, mode), per device. Per mode rather than per entry, so
 * Architecture and OTS share their level. OTS's ALL is stored separately so it doesn't
 * replace the concrete level Architecture needs.
 */
export function saveLastLevel(productId: string, mode: Mode, levelId: string): void {
  write(`${productId}:${mode}`, levelId);
}

export function getLastLevel(productId: string, mode: Mode): string | null {
  return readMap()[`${productId}:${mode}`] ?? null;
}

export function saveOtsAllLevels(productId: string, all: boolean): void {
  write(`${productId}:ots-all`, all ? "1" : "0");
}

/** Defaults to true: OTS opens on ALL until a level is picked. */
export function getOtsAllLevels(productId: string): boolean {
  return readMap()[`${productId}:ots-all`] !== "0";
}

function write(field: string, value: string): void {
  try {
    const map = readMap();
    map[field] = value;
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    // Private browsing / storage disabled - not remembering is a fine degradation.
  }
}

function readMap(): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}
