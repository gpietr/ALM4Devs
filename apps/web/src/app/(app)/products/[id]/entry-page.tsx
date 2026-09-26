"use client";

import { ProductContextStrip } from "@/components/context-strip";
import type { Entry } from "@/lib/product-nav";
import { useActiveLevel } from "@/lib/use-active-level";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";

// One chunk per section: TipTap (requirements' create form) is multi-MB and the other
// entries never use it.
const loading = () => <p className="p-6 text-sm text-muted-foreground">Loading…</p>;
const RequirementsSection = dynamic(() => import("./requirements-section").then((m) => m.RequirementsSection), { loading });
const TestCasesSection = dynamic(() => import("./test-cases-section").then((m) => m.TestCasesSection), { loading });
const TraceabilitySection = dynamic(() => import("./traceability-section").then((m) => m.TraceabilitySection), { loading });
const VersionsSection = dynamic(() => import("./versions-section").then((m) => m.VersionsSection), { loading });
const TestSetsSection = dynamic(() => import("./test-sets-section").then((m) => m.TestSetsSection), { loading });

type ListEntry = Exclude<Entry, "architecture" | "ots">;

/** A list entry: the shell plus one full-width section. Architecture and OTS are
 * workspaces instead (tech/architecture, tech/ots). */
export function ProductEntryPage({ productId, entry }: { productId: string; entry: ListEntry }) {
  const searchParams = useSearchParams();
  const { activeLevelId } = useActiveLevel(productId, entry, searchParams.get("level"));

  return (
    <>
      <ProductContextStrip productId={productId} entry={entry} activeLevelId={activeLevelId} />
      {entry === "traceability" ? (
        <div className="p-6">
          <TraceabilitySection productId={productId} />
        </div>
      ) : entry === "versions" ? (
        <VersionsSection productId={productId} />
      ) : entry === "testSets" ? (
        <TestSetsSection productId={productId} />
      ) : entry === "requirements" ? (
        <RequirementsSection productId={productId} levelId={activeLevelId} />
      ) : (
        <TestCasesSection productId={productId} levelId={activeLevelId} />
      )}
    </>
  );
}
