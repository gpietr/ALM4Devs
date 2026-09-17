"use client";

import { SettingsSectionHeader } from "@/components/settings-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc-client";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";

const UNDISABLEABLE_CATEGORIES = new Set(["draft", "approved"]);

export default function StatusesSettingsPage() {
  const utils = trpc.useUtils();
  const settings = trpc.settings.get.useQuery();

  const renameStatus = trpc.settings.renameStatus.useMutation({
    onSuccess: () => utils.settings.get.invalidate(),
  });
  const setStatusEnabled = trpc.settings.setStatusEnabled.useMutation({
    onSuccess: () => utils.settings.get.invalidate(),
    onError: () => utils.settings.get.invalidate(),
  });
  const reorderStatus = trpc.settings.reorderStatus.useMutation({
    onSuccess: () => utils.settings.get.invalidate(),
  });

  const [editingStatusId, setEditingStatusId] = useState<string | null>(null);
  const [editingStatusName, setEditingStatusName] = useState("");

  if (settings.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading...</p>;
  }
  if (settings.error || !settings.data) {
    return <p className="text-sm text-destructive">{settings.error?.message}</p>;
  }

  const { statuses } = settings.data;

  return (
    <div>
      <SettingsSectionHeader
        title="Statuses"
        description={
          <>
            Rename any status, or disable one your team doesn&apos;t use. Draft and Approved
            can&apos;t be disabled — they anchor the minimum workflow.
          </>
        }
      />

      <ul className="max-w-2xl divide-y divide-border overflow-hidden border border-border">
        {statuses.map((status, i) => (
          <li
            key={status.id}
            className={`flex items-center gap-3 px-3 py-2.5 ${status.isEnabled ? "" : "bg-muted/50 opacity-60"}`}
          >
            <div className="flex flex-col">
              <Button
                variant="ghost"
                size="icon-xs"
                disabled={i === 0}
                onClick={() => reorderStatus.mutate({ statusId: status.id, direction: "up" })}
              >
                <ChevronUp />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                disabled={i === statuses.length - 1}
                onClick={() => reorderStatus.mutate({ statusId: status.id, direction: "down" })}
              >
                <ChevronDown />
              </Button>
            </div>

            {editingStatusId === status.id ? (
              <form
                className="flex flex-1 items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  renameStatus.mutate(
                    { statusId: status.id, name: editingStatusName },
                    { onSuccess: () => setEditingStatusId(null) },
                  );
                }}
              >
                <Input
                  autoFocus
                  value={editingStatusName}
                  onChange={(e) => setEditingStatusName(e.target.value)}
                  className="h-8 flex-1"
                />
                <Button type="submit" variant="ghost" size="sm">
                  Save
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setEditingStatusId(null)}>
                  Cancel
                </Button>
              </form>
            ) : (
              <button
                className="flex-1 text-left text-sm font-medium hover:underline"
                onClick={() => {
                  setEditingStatusId(status.id);
                  setEditingStatusName(status.name);
                }}
              >
                {status.name}
              </button>
            )}

            <span className="text-xs uppercase tracking-wide text-muted-foreground/70">
              {status.category.replaceAll("_", " ")}
            </span>

            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <input
                type="checkbox"
                className="accent-primary"
                checked={status.isEnabled}
                disabled={UNDISABLEABLE_CATEGORIES.has(status.category)}
                onChange={(e) => setStatusEnabled.mutate({ statusId: status.id, enabled: e.target.checked })}
              />
              Enabled
            </label>
          </li>
        ))}
      </ul>
      {(renameStatus.error || setStatusEnabled.error || reorderStatus.error) && (
        <p className="mt-2 text-sm text-destructive">
          {renameStatus.error?.message ?? setStatusEnabled.error?.message ?? reorderStatus.error?.message}
        </p>
      )}
    </div>
  );
}
