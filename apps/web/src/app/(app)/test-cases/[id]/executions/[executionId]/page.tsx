"use client";

import { ProductContextStrip } from "@/components/context-strip";
import { RunInProgressPanel } from "@/components/context-rail";
import { GenerateDocumentButton } from "@/components/generate-document-button";
import { trpc } from "@/lib/trpc-client";
import Link from "next/link";
import { use } from "react";

/** Direct-link route for one execution - still linkable (the rail's History tab and any
 * externally-shared link point straight here), but rendered in the same rail grammar as
 * the test case detail page's own "Run" tab (see context-rail.tsx's RunInProgressPanel)
 * instead of the old card-per-step layout this used to have. A completed execution shows
 * the identical roster/record-box UI, just with nothing left to record - the record box
 * simply doesn't render once every step already has a result and the execution has a
 * completedAt (see RunInProgressPanel). */
export default function ExecutionRunPage({
  params,
}: {
  params: Promise<{ id: string; executionId: string }>;
}) {
  const { id: testCaseId, executionId } = use(params);
  const testCase = trpc.testCases.get.useQuery({ id: testCaseId });
  const environmentName = testCase.data?.executions.find((e) => e.id === executionId)?.environmentName;

  return (
    <>
      {testCase.data && (
        <ProductContextStrip
          productId={testCase.data.testCase.productId}
          artifact="testCases"
          activeLevelId={testCase.data.testCase.levelId}
        />
      )}
      <main className="mx-auto max-w-xl px-5 py-8">
        <Link href={`/test-cases/${testCaseId}`} className="text-[13.5px] text-muted-foreground hover:text-foreground">
          ← Back to test case
        </Link>

        <div className="mt-3">
          <GenerateDocumentButton scope="test_execution" buildRequestBody={() => ({ executionId })} />
        </div>

        <div className="mt-4">
          <RunInProgressPanel executionId={executionId} environmentName={environmentName} />
        </div>
      </main>
    </>
  );
}
