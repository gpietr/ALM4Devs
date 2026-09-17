"use client";

import { ProductContextStrip } from "@/components/context-strip";
import { getLastLevel, saveLastLevel } from "@/lib/last-level";
import { saveLastLocation } from "@/lib/last-location";
import { trpc } from "@/lib/trpc-client";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { use, useEffect, useState } from "react";

type Artifact = "requirements" | "testCases" | "traceability";

/**
 * Each artifact section is its own chunk. Previously all three were static imports on this
 * fully-client page, so TipTap (via RequirementsSection's create form) shipped in page.js
 * even for Traceability / Test cases - multi-MB of ProseMirror that those tabs never use.
 * next/dynamic loads a section only when its artifact is active.
 */
const RequirementsSection = dynamic(
  () => import("./requirements-section").then((m) => m.RequirementsSection),
  { loading: () => <p className="p-6 text-sm text-muted-foreground">Loading…</p> },
);
const TestCasesSection = dynamic(
  () => import("./test-cases-section").then((m) => m.TestCasesSection),
  { loading: () => <p className="p-6 text-sm text-muted-foreground">Loading…</p> },
);
const TraceabilitySection = dynamic(
  () => import("./traceability-section").then((m) => m.TraceabilitySection),
  { loading: () => <p className="p-6 text-sm text-muted-foreground">Loading…</p> },
);

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
      {/* Full width, not a centered column - list/index screens get the whole viewport
          (design_handoff_shell_restructure/README.md's "2a"); each section owns its own
          padding. The "back to all products" link this used to render above every
          artifact is gone - the shell's own product switcher (row 1) already opens
          straight to the same "All products" destination, so this was a second control
          for the one job. */}
      {artifact === "traceability" ? (
        <div className="p-6">
          <TraceabilitySection productId={productId} />
        </div>
      ) : artifact === "requirements" ? (
        <RequirementsSection productId={productId} levelId={activeLevelId} />
      ) : (
        <TestCasesSection productId={productId} levelId={activeLevelId} />
      )}
    </>
  );
}
