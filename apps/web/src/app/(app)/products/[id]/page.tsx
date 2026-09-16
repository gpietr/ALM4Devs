"use client";

import { ProductContextStrip } from "@/components/context-strip";
import { getLastLevel, saveLastLevel } from "@/lib/last-level";
import { saveLastLocation } from "@/lib/last-location";
import { trpc } from "@/lib/trpc-client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { use, useEffect, useState } from "react";
import { RequirementsSection } from "./requirements-section";
import { TestCasesSection } from "./test-cases-section";
import { TraceabilitySection } from "./traceability-section";

type Artifact = "requirements" | "testCases" | "traceability";

export default function ProductDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: productId } = use(params);
  const searchParams = useSearchParams();

  const artifactParam = searchParams.get("artifact");
  const artifact: Artifact =
    artifactParam === "testCases" ? "testCases" : artifactParam === "traceability" ? "traceability" : "requirements";
  const levelParam = searchParams.get("level");

  const requirementLevels = trpc.requirements.listLevels.useQuery();
  const testLevels = trpc.testCases.listLevels.useQuery();
  const levels = artifact === "requirements" ? requirementLevels.data : artifact === "testCases" ? testLevels.data : null;

  // Read in an effect, not during render - localStorage is unavailable during SSR, and
  // reading it synchronously would make the server and first client render disagree.
  // Starts null ("nothing remembered"), so the first render still falls through to
  // `levels?.[0]` below, same as before this existed.
  const [rememberedLevelId, setRememberedLevelId] = useState<string | null>(null);
  useEffect(() => {
    if (artifact === "traceability") return;
    setRememberedLevelId(getLastLevel(productId, artifact));
  }, [productId, artifact]);

  // URL param wins, then the remembered level, then the first level as a last resort (also
  // covers a stale remembered id whose level was since renamed/deleted). N/A to
  // traceability, which spans every level at once.
  const activeLevelId = levels?.some((l) => l.id === levelParam)
    ? levelParam!
    : levels?.some((l) => l.id === rememberedLevelId)
      ? rememberedLevelId!
      : (levels?.[0]?.id ?? null);

  // saveLastLocation feeds the home page's "back to where you were" redirect (one global
  // slot - see last-location.ts); saveLastLevel remembers per (product, artifact) instead,
  // for the tab-switch case above.
  useEffect(() => {
    saveLastLocation({ productId, artifact, levelId: artifact === "traceability" ? null : activeLevelId });
    if (artifact !== "traceability" && activeLevelId) saveLastLevel(productId, artifact, activeLevelId);
  }, [productId, artifact, activeLevelId]);

  return (
    <>
      <ProductContextStrip productId={productId} artifact={artifact} activeLevelId={activeLevelId} />
      {/* Wider than the other two tabs' max-w-3xl - the traceability table has five real
          columns (requirement, level, test case, execution, status) and needs the room. */}
      <main className={`mx-auto px-4 py-10 ${artifact === "traceability" ? "max-w-6xl" : "max-w-3xl"}`}>
        <Link href="/products" className="text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground">
          ← All products
        </Link>
        <div className="mt-4">
        {artifact === "requirements" ? (
          <RequirementsSection productId={productId} levelId={activeLevelId} />
        ) : artifact === "testCases" ? (
          <TestCasesSection productId={productId} levelId={activeLevelId} />
        ) : (
          <TraceabilitySection productId={productId} />
        )}
        </div>
      </main>
    </>
  );
}
