"use client";

import { TopBar } from "@/components/context-strip";
import { OrderedListEditor } from "@/components/ordered-list-editor";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc-client";
import { ChevronDown, ChevronUp } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

const UNDISABLEABLE_CATEGORIES = new Set(["draft", "approved"]);

export default function SettingsPage() {
  const utils = trpc.useUtils();
  const settings = trpc.settings.get.useQuery();

  const updateApproval = trpc.settings.updateApprovalSettings.useMutation({
    onSuccess: () => utils.settings.get.invalidate(),
  });
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

  const createLevel = trpc.settings.createLevel.useMutation({ onSuccess: () => utils.settings.get.invalidate() });
  const renameLevel = trpc.settings.renameLevel.useMutation({ onSuccess: () => utils.settings.get.invalidate() });
  const updateLevelCode = trpc.settings.updateLevelCode.useMutation({
    onSuccess: () => utils.settings.get.invalidate(),
  });
  const reorderLevel = trpc.settings.reorderLevel.useMutation({ onSuccess: () => utils.settings.get.invalidate() });
  const deleteLevel = trpc.settings.deleteLevel.useMutation({ onSuccess: () => utils.settings.get.invalidate() });

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

  const [editingStatusId, setEditingStatusId] = useState<string | null>(null);
  const [editingStatusName, setEditingStatusName] = useState("");

  if (settings.isLoading) {
    return <main className="mx-auto max-w-2xl px-4 py-16 text-sm text-muted-foreground">Loading...</main>;
  }
  if (settings.error || !settings.data) {
    return <main className="mx-auto max-w-2xl px-4 py-16 text-sm text-destructive">{settings.error?.message}</main>;
  }

  const { approval, statuses, levels, testLevels, environments } = settings.data;

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-2xl px-4 py-10">
      <div className="mb-8 flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <Link href="/" className="text-sm text-muted-foreground underline underline-offset-2">
          Back home
        </Link>
      </div>

      <section className="mt-8">
        <h2 className="text-sm font-medium text-foreground">Custom fields</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Extra fields your team wants on every requirement or test case, beyond the
          built-in ones.
        </p>
        <Link href="/settings/custom-fields" className={buttonVariants({ variant: "outline", className: "mt-3" })}>
          Manage custom fields →
        </Link>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-medium text-foreground">Document templates</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Templates for generating a PDF from a test case, a test execution, or a list of
          requirements - your own HTML with placeholders, filled in from real data.
        </p>
        <Link href="/settings/document-templates" className={buttonVariants({ variant: "outline", className: "mt-3" })}>
          Manage document templates →
        </Link>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-medium text-foreground">AI-assisted test step drafting</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Bring your own API key for Anthropic, OpenAI, or any OpenAI-compatible endpoint
          (self-hosted or third-party) to draft and revise test steps by chatting with it.
        </p>
        <Link href="/settings/ai" className={buttonVariants({ variant: "outline", className: "mt-3" })}>
          Set up AI connection →
        </Link>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-medium text-foreground">Import from a 3rd-party tool</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          One-time import of requirements and test cases from Spira. Not something you do
          every day, so it lives here rather than its own top-level page.
        </p>
        <Link href="/settings/import" className={buttonVariants({ variant: "outline", className: "mt-3" })}>
          Import from Spira →
        </Link>
      </section>

      <section className="mt-10">
        <h2 className="text-sm font-medium text-foreground">Approval process</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Both are off by default - turn them on if your process needs them.
        </p>
        <div className="mt-4 space-y-3">
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
        </div>
        {updateApproval.error && <p className="mt-2 text-sm text-destructive">{updateApproval.error.message}</p>}
      </section>

      <section className="mt-10">
        <h2 className="text-sm font-medium text-foreground">Requirement hierarchy levels</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          A requirement&apos;s optional parent must be at a higher level. A level in use
          can&apos;t be deleted. The code is the id prefix shown everywhere a requirement
          under that level appears (e.g. SYSREQ-1, SYSREQ-2) - editable any time, but the
          number after it never changes once assigned.
        </p>
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
      </section>

      <section className="mt-10">
        <h2 className="text-sm font-medium text-foreground">Test case levels</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Test cases can be organized the same way requirements are - one &quot;Default&quot;
          level to start. Same id-prefix code mechanism as requirement levels above.
        </p>
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
      </section>

      <section className="mt-10">
        <h2 className="text-sm font-medium text-foreground">Test environments</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Recorded on every test execution - e.g. Staging, Device Simulator.
        </p>
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
      </section>

      <section className="mt-10">
        <h2 className="text-sm font-medium text-foreground">Statuses</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Rename any status, or disable one your team doesn&apos;t use. Draft and Approved
          can&apos;t be disabled - they anchor the minimum workflow.
        </p>
        <ul className="mt-4 divide-y divide-border overflow-hidden rounded-md border">
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
      </section>
      </main>
    </>
  );
}
