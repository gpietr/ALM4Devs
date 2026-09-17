"use client";

import { OrderedListEditor } from "@/components/ordered-list-editor";
import { SettingsSectionHeader } from "@/components/settings-shell";
import { trpc } from "@/lib/trpc-client";

export default function RequirementLevelsSettingsPage() {
  const utils = trpc.useUtils();
  const settings = trpc.settings.get.useQuery();

  const createLevel = trpc.settings.createLevel.useMutation({ onSuccess: () => utils.settings.get.invalidate() });
  const renameLevel = trpc.settings.renameLevel.useMutation({ onSuccess: () => utils.settings.get.invalidate() });
  const updateLevelCode = trpc.settings.updateLevelCode.useMutation({
    onSuccess: () => utils.settings.get.invalidate(),
  });
  const reorderLevel = trpc.settings.reorderLevel.useMutation({ onSuccess: () => utils.settings.get.invalidate() });
  const deleteLevel = trpc.settings.deleteLevel.useMutation({ onSuccess: () => utils.settings.get.invalidate() });

  if (settings.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading...</p>;
  }
  if (settings.error || !settings.data) {
    return <p className="text-sm text-destructive">{settings.error?.message}</p>;
  }

  const { levels } = settings.data;

  return (
    <div>
      <SettingsSectionHeader
        title="Requirement levels"
        description={
          <>
            A requirement&apos;s optional parent must be at a higher level. A level in use
            can&apos;t be deleted. The code is the id prefix shown everywhere a requirement
            under that level appears (e.g. SYSREQ-1, SYSREQ-2) — editable any time, but the
            number after it never changes once assigned.
          </>
        }
      />

      <div className="max-w-2xl">
        <OrderedListEditor
          items={levels}
          onRename={(id, name) => renameLevel.mutate({ levelId: id, name })}
          onUpdateCode={(id, code) => updateLevelCode.mutate({ levelId: id, code })}
          onReorder={(id, direction) => reorderLevel.mutate({ levelId: id, direction })}
          onDelete={(id) => deleteLevel.mutate({ levelId: id })}
          onCreate={(name, code) => createLevel.mutate({ name, code: code ?? "" })}
          createPlaceholder="New level name"
          createCodePlaceholder="CODE"
          error={
            renameLevel.error?.message ??
            updateLevelCode.error?.message ??
            reorderLevel.error?.message ??
            deleteLevel.error?.message ??
            createLevel.error?.message
          }
        />
      </div>
    </div>
  );
}
