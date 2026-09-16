"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";

/**
 * Reads/writes a page's filter and sort state as URL query params, so a filtered/sorted
 * view is a real, shareable link rather than local-only component state. `setParams`
 * merges into whatever's already in the URL (never clobbers unrelated params like
 * `artifact`/`level`) and replaces history rather than pushing, so tweaking a filter
 * doesn't spam the back button with one entry per keystroke/click. Setting a key to
 * `undefined` or `""` removes it entirely, so a link at its default filter/sort state
 * stays clean instead of accumulating `?status=&safety=&sortBy=` noise.
 */
export function useUrlState() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const setParams = useCallback(
    (patch: Record<string, string | undefined>) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined || value === "") next.delete(key);
        else next.set(key, value);
      }
      const query = next.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  return { searchParams, setParams };
}
