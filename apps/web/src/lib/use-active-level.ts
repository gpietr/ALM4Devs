"use client";

import { getLastLevel, getOtsAllLevels, saveLastLevel, saveOtsAllLevels } from "@/lib/last-level";
import { saveLastLocation } from "@/lib/last-location";
import { ALL_LEVELS, ENTRIES, type Entry } from "@/lib/product-nav";
import { trpc } from "@/lib/trpc-client";
import { useEffect, useState } from "react";

/**
 * The entry's active level: URL param, then the level last used in this mode, then the
 * first level. `fixedLevelId` overrides all of them (an item view is on its node's
 * level). OTS also accepts `ALL_LEVELS`, its default. Null for entries without a rail.
 */
export function useActiveLevel(productId: string, entry: Entry, levelParam: string | null, fixedLevelId?: string | null) {
  const def = ENTRIES[entry];
  const requirementLevels = trpc.requirements.listLevels.useQuery(undefined, { enabled: def.levels === "requirements" });
  const architectureLevels = trpc.architecture.listLevels.useQuery(undefined, { enabled: def.levels === "architecture" });
  const testLevels = trpc.testCases.listLevels.useQuery(undefined, { enabled: def.levels === "tests" });
  const levelsQuery =
    def.levels === "requirements"
      ? requirementLevels
      : def.levels === "architecture"
        ? architectureLevels
        : def.levels === "tests"
          ? testLevels
          : null;
  const levels = levelsQuery?.data;

  // Read in an effect: localStorage is unavailable during SSR.
  const [remembered, setRemembered] = useState<{ levelId: string | null; otsAll: boolean } | null>(null);
  useEffect(() => {
    if (!def.levels) return;
    setRemembered({ levelId: getLastLevel(productId, def.mode), otsAll: getOtsAllLevels(productId) });
  }, [productId, def.levels, def.mode]);

  const known = (id: string | null | undefined): id is string => !!id && !!levels?.some((l) => l.id === id);
  let activeLevelId: string | null = null;
  if (def.levels && levels) {
    if (fixedLevelId !== undefined) {
      activeLevelId = known(fixedLevelId) ? fixedLevelId : null;
    } else if (entry === "ots" && levelParam === ALL_LEVELS) {
      activeLevelId = ALL_LEVELS;
    } else if (known(levelParam)) {
      activeLevelId = levelParam;
    } else if (entry === "ots" && (!remembered || remembered.otsAll)) {
      activeLevelId = ALL_LEVELS;
    } else if (known(remembered?.levelId)) {
      activeLevelId = remembered.levelId;
    } else {
      activeLevelId = levels[0]?.id ?? null;
    }
  }

  useEffect(() => {
    // Wait for the remembered level, or the first render's fallback would overwrite it.
    if (def.levels && (!activeLevelId || !remembered)) return;
    saveLastLocation({ productId, entry, levelId: activeLevelId });
    if (!activeLevelId) return;
    if (entry === "ots" && fixedLevelId === undefined) saveOtsAllLevels(productId, activeLevelId === ALL_LEVELS);
    if (activeLevelId !== ALL_LEVELS) saveLastLevel(productId, def.mode, activeLevelId);
  }, [productId, entry, activeLevelId, def.levels, def.mode, fixedLevelId, remembered]);

  return {
    activeLevelId,
    levels: levels ?? null,
    isLoading: !!levelsQuery?.isLoading,
    error: levelsQuery?.error ?? null,
  };
}
