"use client";

import { getLastLocation, lastLocationHref } from "@/lib/last-location";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Renders nothing - on mount, sends the user straight back to the product/artifact/level
 * they were last looking at (see last-location.ts), if any is remembered. Lets the home
 * page stay a server component with its normal fallback content (shown only for a first
 * visit, or if nothing's remembered / storage is unavailable) instead of turning the whole
 * page client-side just for this one redirect.
 */
export function LastLocationRedirect() {
  const router = useRouter();
  useEffect(() => {
    const last = getLastLocation();
    if (last) router.replace(lastLocationHref(last));
  }, [router]);
  return null;
}
