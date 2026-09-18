"use client";

import { OrderedListEditor } from "@/components/ordered-list-editor";
import { SettingsSectionHeader } from "@/components/settings-shell";
import { trpc } from "@/lib/trpc-client";

export default function ArchitectureLevelsSettingsPage() {
  const utils = trpc.useUtils();
  const settings = trpc.settings.get.useQuery();

  const createLevel = trpc.settings.createArchitectureLevel.useMutation({
    onSuccess: () => utils.settings.get.invalidate(),
  });
  const renameLevel = trpc.settings.renameArchitectureLevel.useMutation({
    onSuccess: () => utils.settings.get.invalidate(),
  });
  const updateLevelCode = trpc.settings.updateArchitectureLevelCode.useMutation({
    onSuccess: () => utils.settings.get.invalidate(),
  });
  const reorderLevel = trpc.settings.reorderArchitectureLevel.useMutation({
    onSuccess: () => utils.settings.get.invalidate(),
  });
  const deleteLevel = trpc.settings.deleteArchitectureLevel.useMutation({
    onSuccess: () => utils.settings.get.invalidate(),
  });

  if (settings.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading...</p>;
  }
  if (settings.error || !settings.data) {
    return <p className="text-sm text-destructive">{settings.error?.message}</p>;
  }

  const { architectureLevels } = settings.data;

  return (
    <div>
      <SettingsSectionHeader
        title="Architecture levels"
        description={
          <>
            Each architecture level is its own tree (system vs software, or one level per
            software). A level in use can&apos;t be deleted. The code is the id prefix shown
            on every node under that level (e.g. SYSARCH-1).
          </>
        }
      />

      <div className="max-w-2xl">
        <OrderedListEditor
          items={architectureLevels}
          onRename={(id, name) => renameLevel.mutate({ levelId: id, name })}
          onUpdateCode={(id, code) => updateLevelCode.mutate({ levelId: id, code })}
          onReorder={(id, direction) => reorderLevel.mutate({ levelId: id, direction })}
          onDelete={(id) => deleteLevel.mutate({ levelId: id })}
          onCreate={(name, code) => createLevel.mutate({ name, code: code ?? "" })}
          createPlaceholder="New architecture level name"
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
