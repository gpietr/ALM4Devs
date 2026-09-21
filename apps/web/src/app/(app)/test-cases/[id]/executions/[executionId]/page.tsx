"use client";

import { TopBar } from "@/components/context-strip";
import { TestRunView } from "@/components/test-run-view";
import { formatItemId } from "@/lib/format-item-id";
import { trpc } from "@/lib/trpc-client";
import { use } from "react";

/** Direct-link route for one execution - still linkable (the rail's History tab and any
 * externally-shared link point straight here). Renders the full "protocol" layout
 * (see @/components/test-run-view's TestRunView) rather than the docked context rail's
 * compact Run tab - this route owns the whole page, so it gets the roster and recorder
 * laid out side by side instead of stacked into a 352px aside. Just `TopBar` (no
 * artifact-tab row) above it, same "focused mode" chrome the layout was designed for. A
 * completed execution shows the identical roster/record-box UI, just with nothing left to
 * record - the record box simply doesn't render once every step already has a result and
 * the execution has a completedAt (see TestRunView). */
export default function ExecutionRunPage({
  params,
}: {
  params: Promise<{ id: string; executionId: string }>;
}) {
  const { id: testCaseId, executionId } = use(params);
  const testCase = trpc.testCases.get.useQuery({ id: testCaseId });
  const environmentName = testCase.data?.executions.find((e) => e.id === executionId)?.environmentName;

  const stepRequirementLinks = new Map(
    (testCase.data?.steps ?? []).map((s) => [
      s.id,
      s.requirementLinks.map((l) => ({ id: l.id, levelCode: l.levelCode, sequenceNumber: l.sequenceNumber })),
    ]),
  );

  return (
    <>
      <TopBar productId={testCase.data?.testCase.productId ?? null} />
      <TestRunView
        testCaseId={testCaseId}
        executionId={executionId}
        testCaseTitle={testCase.data?.testCase.title}
        testCaseDisplayId={testCase.data ? formatItemId(testCase.data.testCase.levelCode, testCase.data.testCase.sequenceNumber) : undefined}
        environmentName={environmentName}
        coverageLinks={testCase.data?.effectiveRequirementLinks ?? []}
        stepRequirementLinks={stepRequirementLinks}
      />
    </>
  );
}
