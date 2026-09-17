"use client";

import { OrderedListEditor } from "@/components/ordered-list-editor";
import { SettingsSectionHeader } from "@/components/settings-shell";
import { trpc } from "@/lib/trpc-client";

export default function EnvironmentsSettingsPage() {
  const utils = trpc.useUtils();
  const settings = trpc.settings.get.useQuery();

  const createEnvironment = trpc.settings.createEnvironment.useMutation({
    onSuccess: () => utils.settings.get.invalidate(),
  });
  const renameEnvironment = trpc.settings.renameEnvironment.useMutation({
    onSuccess: () => utils.settings.get.invalidate(),
  });
  const reorderEnvironment = trpc.settings.reorderEnvironment.useMutation({
    onSuccess: () => utils.settings.get.invalidate(),
  });
  const deleteEnvironment = trpc.settings.deleteEnvironment.useMutation({
    onSuccess: () => utils.settings.get.invalidate(),
  });

  if (settings.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading...</p>;
  }
  if (settings.error || !settings.data) {
    return <p className="text-sm text-destructive">{settings.error?.message}</p>;
  }

  const { environments } = settings.data;

  return (
    <div>
      <SettingsSectionHeader
        title="Environments"
        description="Recorded on every test execution — e.g. Staging, Device Simulator."
      />

      <div className="max-w-2xl">
        <OrderedListEditor
          items={environments}
          onRename={(id, name) => renameEnvironment.mutate({ environmentId: id, name })}
          onReorder={(id, direction) => reorderEnvironment.mutate({ environmentId: id, direction })}
          onDelete={(id) => deleteEnvironment.mutate({ environmentId: id })}
          onCreate={(name) => createEnvironment.mutate({ name })}
          createPlaceholder="New environment name"
          error={
            renameEnvironment.error?.message ??
            reorderEnvironment.error?.message ??
            deleteEnvironment.error?.message ??
            createEnvironment.error?.message
          }
        />
      </div>
    </div>
  );
}
