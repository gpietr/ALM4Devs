"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { trpc } from "@/lib/trpc-client";

// Standalone copy of @galm/core's OTS_VERSION_SUPPORT_STATUSES (client component).
const SUPPORT_STATUSES = [
  { value: "in_use", label: "In use" },
  { value: "allowed", label: "Allowed" },
  { value: "retired", label: "Retired" },
] as const;

/** Per-version support status ("allowed" = validated for use). */
export function OtsVersionControls({
  nodeId,
  versionId,
  supportStatus,
}: {
  nodeId: string;
  versionId: string;
  supportStatus: string;
}) {
  const utils = trpc.useUtils();
  const setStatus = trpc.ots.setVersionStatus.useMutation({
    onSuccess: () =>
      Promise.all([
        utils.ots.documentation.invalidate({ nodeId }),
        utils.ots.register.invalidate(),
        utils.architecture.get.invalidate({ id: nodeId }),
      ]),
  });

  return (
    <div className="space-y-2">
      <Select value={supportStatus} onValueChange={(v) => v && setStatus.mutate({ nodeId, versionId, supportStatus: v as (typeof SUPPORT_STATUSES)[number]["value"] })}>
        <SelectTrigger size="sm" className="h-7 w-28 text-[12px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SUPPORT_STATUSES.map((s) => (
            <SelectItem key={s.value} value={s.value}>
              {s.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {setStatus.error && <p className="text-sm text-destructive">{setStatus.error.message}</p>}
    </div>
  );
}
