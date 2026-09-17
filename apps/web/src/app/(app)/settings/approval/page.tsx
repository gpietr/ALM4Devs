"use client";

import { SettingsSectionHeader } from "@/components/settings-shell";
import { Card } from "@/components/ui/card";
import { trpc } from "@/lib/trpc-client";

export default function ApprovalSettingsPage() {
  const utils = trpc.useUtils();
  const settings = trpc.settings.get.useQuery();
  const updateApproval = trpc.settings.updateApprovalSettings.useMutation({
    onSuccess: () => utils.settings.get.invalidate(),
  });

  if (settings.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading...</p>;
  }
  if (settings.error || !settings.data) {
    return <p className="text-sm text-destructive">{settings.error?.message}</p>;
  }

  const { approval } = settings.data;

  return (
    <div>
      <SettingsSectionHeader
        title="Approval"
        description="Both are off by default — turn them on if your process needs them."
      />

      <div className="max-w-2xl space-y-3">
        <Card className="p-3">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              className="mt-0.5 accent-primary"
              checked={approval.requireEsignature}
              onChange={(e) => updateApproval.mutate({ requireEsignature: e.target.checked })}
            />
            <span>
              <span className="block text-sm font-medium">Require e-signature</span>
              <span className="block text-sm text-muted-foreground">
                Moving a requirement to Approved or Baselined requires typing your name and
                re-entering your password.
              </span>
            </span>
          </label>
        </Card>
        <Card className="p-3">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              className="mt-0.5 accent-primary"
              checked={approval.requireIndependentReview}
              onChange={(e) => updateApproval.mutate({ requireIndependentReview: e.target.checked })}
            />
            <span>
              <span className="block text-sm font-medium">Require independent review</span>
              <span className="block text-sm text-muted-foreground">
                The person approving a requirement (moving it to Approved or Baselined)
                cannot be the same person who authored it.
              </span>
            </span>
          </label>
        </Card>
        {updateApproval.error && (
          <p className="text-sm text-destructive">{updateApproval.error.message}</p>
        )}
      </div>
    </div>
  );
}
