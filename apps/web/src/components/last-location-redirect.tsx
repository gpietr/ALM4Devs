"use client";

import { buttonVariants } from "@/components/ui/button";
import { getLastLocation, lastLocationHref } from "@/lib/last-location";
import { trpc } from "@/lib/trpc-client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * The home page's dynamic half - the product/artifact/level a returning user was last
 * looking at is per-device (localStorage, see last-location.ts), so this has to be a
 * client component; the rest of the page stays a server component (see page.tsx) rather
 * than paying for a fully client-rendered page just for this.
 *
 * On mount: if a last location is remembered, replace straight there. Otherwise there's
 * no product "selected" yet, so fall back on the tenant's product list - auto-continuing
 * only when it's unambiguous (exactly one product), and otherwise rendering copy that
 * tells the user what to do next rather than silently doing nothing.
 */
export function LastLocationRedirect() {
  const router = useRouter();
  const [hasLastLocation, setHasLastLocation] = useState<boolean | null>(null);

  useEffect(() => {
    const last = getLastLocation();
    if (last) {
      router.replace(lastLocationHref(last));
      setHasLastLocation(true);
    } else {
      setHasLastLocation(false);
    }
  }, [router]);

  const products = trpc.products.list.useQuery(undefined, { enabled: hasLastLocation === false });

  useEffect(() => {
    const onlyProduct = products.data?.length === 1 ? products.data[0] : undefined;
    if (onlyProduct) router.replace(`/products/${onlyProduct.id}`);
  }, [products.data, router]);

  // Still checking localStorage, redirecting to a remembered location, or about to
  // redirect to the tenant's one product - nothing to show for any of those.
  if (hasLastLocation !== false || products.isLoading || products.data?.length === 1) return null;

  return (
    <div className="mt-10">
      <p className="mb-3 text-sm text-muted-foreground">
        {products.data?.length === 0
          ? "You don't have any products yet — create one to get started."
          : "Select a product to get started."}
      </p>
      <Link href="/products" className={buttonVariants({ size: "lg" })}>
        Go to Products →
      </Link>
    </div>
  );
}
