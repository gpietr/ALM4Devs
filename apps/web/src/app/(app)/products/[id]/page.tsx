"use client";

import { getLastLocation, lastLocationHref } from "@/lib/last-location";
import { entryHref } from "@/lib/product-nav";
import { useRouter } from "next/navigation";
import { use, useEffect } from "react";

/** Reopens where you last were in this product, or Requirements. */
export default function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();

  useEffect(() => {
    const last = getLastLocation();
    router.replace(last?.productId === id ? lastLocationHref(last) : entryHref(id, "requirements"));
  }, [id, router]);

  return null;
}
