"use client";

import { OrderedListEditor } from "@/components/ordered-list-editor";
import { SettingsSectionHeader } from "@/components/settings-shell";
import { trpc } from "@/lib/trpc-client";

export default function TestLevelsSettingsPage() {
  const utils = trpc.useUtils();
  const settings = trpc.settings.get.useQuery();

  const createTestLevel = trpc.settings.createTestLevel.useMutation({
    onSuccess: () => utils.settings.get.invalidate(),
  });
  const renameTestLevel = trpc.settings.renameTestLevel.useMutation({
    onSuccess: () => utils.settings.get.invalidate(),
  });
  const updateTestLevelCode = trpc.settings.updateTestLevelCode.useMutation({
    onSuccess: () => utils.settings.get.invalidate(),
  });
  const reorderTestLevel = trpc.settings.reorderTestLevel.useMutation({
    onSuccess: () => utils.settings.get.invalidate(),
  });
  const deleteTestLevel = trpc.settings.deleteTestLevel.useMutation({
    onSuccess: () => utils.settings.get.invalidate(),
  });

  if (settings.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading...</p>;
  }
  if (settings.error || !settings.data) {
    return <p className="text-sm text-destructive">{settings.error?.message}</p>;
  }

  const { testLevels } = settings.data;

  return (
    <div>
      <SettingsSectionHeader
        title="Test case levels"
        description={
          <>
            Test cases can be organized the same way requirements are — one &quot;Default&quot;
            level to start. Same id-prefix code mechanism as requirement levels.
          </>
        }
      />

      <div className="max-w-2xl">
        <OrderedListEditor
          items={testLevels}
          onRename={(id, name) => renameTestLevel.mutate({ levelId: id, name })}
          onUpdateCode={(id, code) => updateTestLevelCode.mutate({ levelId: id, code })}
          onReorder={(id, direction) => reorderTestLevel.mutate({ levelId: id, direction })}
          onDelete={(id) => deleteTestLevel.mutate({ levelId: id })}
          onCreate={(name, code) => createTestLevel.mutate({ name, code: code ?? "" })}
          createPlaceholder="New test level name"
          createCodePlaceholder="CODE"
          error={
            renameTestLevel.error?.message ??
            updateTestLevelCode.error?.message ??
            reorderTestLevel.error?.message ??
            deleteTestLevel.error?.message ??
            createTestLevel.error?.message
          }
        />
      </div>
    </div>
  );
}
