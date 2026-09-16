"use client";

import { ProductContextStrip } from "@/components/context-strip";
import { EsignModal } from "@/components/esign-modal";
import {
  asCustomFieldDefinitions,
  customFieldFormStateFromValues,
  type CustomFieldFormState,
  CustomFieldInputs,
  formatCustomFieldValue,
  toCustomFieldValuesInput,
} from "@/components/custom-fields";
import { RichTextEditor } from "@/components/rich-text-editor";
import { RichTextView } from "@/components/rich-text-view";
import { StatusPill } from "@/components/status-pill";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { VersionDiff } from "@/components/version-diff";
import { formatItemId } from "@/lib/format-item-id";
import { trpc } from "@/lib/trpc-client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useEffect, useRef, useState } from "react";

export default function RequirementDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const utils = trpc.useUtils();
  const detail = trpc.requirements.get.useQuery({ id });
  const allowedTransitions = trpc.requirements.allowedTransitions.useQuery({ requirementId: id });
  const customFieldsQuery = trpc.settings.listCustomFields.useQuery({ entityType: "requirement" });
  const customFieldDefs = asCustomFieldDefinitions(customFieldsQuery.data ?? []);

  const editDraft = trpc.requirements.editDraft.useMutation({
    onSuccess: () => {
      utils.requirements.get.invalidate({ id });
      utils.requirements.allowedTransitions.invalidate({ requirementId: id });
    },
  });
  const transition = trpc.requirements.transition.useMutation({
    onSuccess: () => {
      utils.requirements.get.invalidate({ id });
      utils.requirements.allowedTransitions.invalidate({ requirementId: id });
    },
  });
  const updateCustomFieldValues = trpc.requirements.updateCustomFieldValues.useMutation({
    onSuccess: () => utils.requirements.get.invalidate({ id }),
  });
  const deleteRequirement = trpc.requirements.delete.useMutation();

  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [background, setBackground] = useState("");
  const [pendingEsign, setPendingEsign] = useState<{ category: string; label: string } | null>(null);
  const [expandedVersionId, setExpandedVersionId] = useState<string | null>(null);
  const [editingCustomFields, setEditingCustomFields] = useState(false);
  const [customFieldState, setCustomFieldState] = useState<CustomFieldFormState>({});

  // Open straight into edit mode, not a read-only view first - a read-only landing only
  // makes sense once the current version is locked out of further edits (anything past
  // draft: in_review/approved/baselined). Guarded by a ref rather than derived from
  // `detail.data` directly so this only fires once per page visit: it must not re-trigger
  // and stomp on in-progress edits every time the query refetches (e.g. after saving).
  const hasAutoOpenedRef = useRef(false);
  useEffect(() => {
    if (hasAutoOpenedRef.current || !detail.data) return;
    const latest = detail.data.versions[0];
    if (!latest) return;
    hasAutoOpenedRef.current = true;
    if (latest.statusCategory === "draft") {
      setTitle(latest.title);
      setDescription(latest.description);
      setBackground(latest.background ?? "");
      setEditing(true);
    }
  }, [detail.data]);

  if (detail.isLoading) return <main className="mx-auto max-w-3xl px-4 py-16 text-sm text-muted-foreground">Loading...</main>;
  if (detail.error) return <main className="mx-auto max-w-3xl px-4 py-16 text-sm text-destructive">{detail.error.message}</main>;
  if (!detail.data) return null;

  const { requirement, versions, children, coveringTestCases, customFieldValues } = detail.data;
  const current = versions[0];
  if (!current) return null;

  function startEditing() {
    setTitle(current!.title);
    setDescription(current!.description);
    setBackground(current!.background ?? "");
    setEditing(true);
  }

  function doTransition(toCategory: string, opts?: { typedName: string; reauthToken: string }) {
    transition.mutate({
      requirementId: id,
      toCategory: toCategory as never,
      typedName: opts?.typedName,
      reauthToken: opts?.reauthToken,
    });
  }

  return (
    <>
      <ProductContextStrip productId={requirement.productId} artifact="requirements" activeLevelId={requirement.levelId} />
      <main className="mx-auto max-w-3xl px-4 py-10">
      <Link
        href={`/products/${requirement.productId}?artifact=requirements&level=${requirement.levelId}`}
        className="text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground"
      >
        ← Back to {requirement.levelName}
      </Link>
      <div className="mt-4 flex items-start justify-between">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            <span className="font-mono font-semibold text-primary">
              {formatItemId(requirement.levelCode, requirement.sequenceNumber)}
            </span>{" "}
            · {requirement.levelName}
            {requirement.safetyClassification ? ` · Class ${requirement.safetyClassification}` : ""}
          </p>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">{current.title}</h1>
          {requirement.parentTitle && requirement.parentRequirementId && (
            <p className="mt-1 text-sm text-muted-foreground">
              Traces to{" "}
              <Link
                href={`/requirements/${requirement.parentRequirementId}`}
                className="text-primary underline underline-offset-2 hover:text-primary/80"
              >
                {requirement.parentLevelCode && requirement.parentSequenceNumber
                  ? `${formatItemId(requirement.parentLevelCode, requirement.parentSequenceNumber)}: `
                  : ""}
                {requirement.parentTitle}
              </Link>
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-2">
          <StatusPill category={current.statusCategory} name={current.statusName} />
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-destructive"
            disabled={deleteRequirement.isPending}
            onClick={() => {
              if (
                !confirm(
                  `Delete ${formatItemId(requirement.levelCode, requirement.sequenceNumber)} "${current.title}"? This cannot be undone.`,
                )
              ) {
                return;
              }
              deleteRequirement.mutate(
                { id },
                {
                  onSuccess: () =>
                    router.push(`/products/${requirement.productId}?artifact=requirements&level=${requirement.levelId}`),
                },
              );
            }}
          >
            {deleteRequirement.isPending ? "Deleting..." : "Delete"}
          </Button>
        </div>
      </div>
      {deleteRequirement.error && (
        <p className="mt-2 text-sm text-destructive">{deleteRequirement.error.message}</p>
      )}

      {children.length > 0 && (
        <div className="mt-3 text-sm text-muted-foreground">
          Traced to by:{" "}
          {children.map((c, i) => (
            <span key={c.id}>
              {i > 0 && ", "}
              <Link href={`/requirements/${c.id}`} className="text-primary underline underline-offset-2 hover:text-primary/80">
                {formatItemId(c.levelCode, c.sequenceNumber)}: {c.title}
              </Link>
            </span>
          ))}
        </div>
      )}

      <div className="mt-3 text-sm text-muted-foreground">
        {coveringTestCases.length > 0 ? (
          <>
            Covered by:{" "}
            {coveringTestCases.map((tc, i) => (
              <span key={tc.id}>
                {i > 0 && ", "}
                <Link href={`/test-cases/${tc.id}`} className="text-primary underline underline-offset-2 hover:text-primary/80">
                  {formatItemId(tc.levelCode, tc.sequenceNumber)}: {tc.title}
                </Link>
              </span>
            ))}
          </>
        ) : (
          "Not covered by any test case yet."
        )}
      </div>

      <Card className="mt-6 p-4">
        {editing ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              editDraft.mutate(
                { requirementId: id, title, description, background: background || undefined },
                { onSuccess: () => setEditing(false) },
              );
            }}
            className="space-y-3"
          >
            <Input required value={title} onChange={(e) => setTitle(e.target.value)} />
            <Textarea required value={description} onChange={(e) => setDescription(e.target.value)} rows={4} />
            <Label className="flex-col items-start gap-1">
              <span className="text-xs font-medium text-muted-foreground">Background (optional)</span>
              <RichTextEditor value={background} onChange={setBackground} />
            </Label>
            {editDraft.error && <p className="text-sm text-destructive">{editDraft.error.message}</p>}
            <div className="flex gap-2">
              <Button type="submit" disabled={editDraft.isPending}>
                Save new version
              </Button>
              <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <>
            <p className="whitespace-pre-wrap text-sm text-foreground/90">{current.description}</p>
            {current.background && (
              <div className="mt-4 border-t pt-4">
                <p className="text-xs font-medium text-muted-foreground">Background</p>
                <RichTextView html={current.background} />
              </div>
            )}
            {current.statusCategory === "draft" ? (
              <Button variant="outline" size="sm" onClick={startEditing} className="mt-4">
                Edit (new version)
              </Button>
            ) : (
              <p className="mt-4 text-xs text-muted-foreground">
                This version is {current.statusName.toLowerCase()} and locked for editing - see the available
                transitions below.
              </p>
            )}
          </>
        )}
      </Card>

      {customFieldDefs.length > 0 && (
        <Card className="mt-6 p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-foreground">Custom fields</h2>
            {!editingCustomFields && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setCustomFieldState(customFieldFormStateFromValues(customFieldValues));
                  setEditingCustomFields(true);
                }}
              >
                Edit
              </Button>
            )}
          </div>
          {editingCustomFields ? (
            <form
              className="mt-3 space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                updateCustomFieldValues.mutate(
                  { requirementId: id, values: toCustomFieldValuesInput(customFieldState) },
                  { onSuccess: () => setEditingCustomFields(false) },
                );
              }}
            >
              <CustomFieldInputs
                fields={customFieldDefs}
                state={customFieldState}
                onChange={(fieldId, value) => setCustomFieldState((s) => ({ ...s, [fieldId]: value }))}
              />
              {updateCustomFieldValues.error && (
                <p className="text-sm text-destructive">{updateCustomFieldValues.error.message}</p>
              )}
              <div className="flex gap-2">
                <Button type="submit" disabled={updateCustomFieldValues.isPending}>
                  Save
                </Button>
                <Button type="button" variant="ghost" onClick={() => setEditingCustomFields(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <dl className="mt-3 space-y-2 text-sm">
              {customFieldValues.map((v) => (
                <div key={v.fieldId} className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">{v.name}</dt>
                  <dd className="text-right text-foreground">{formatCustomFieldValue(v)}</dd>
                </div>
              ))}
            </dl>
          )}
        </Card>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-2">
        {allowedTransitions.data?.allowed.map((t) => (
          <div key={t.category} className="flex flex-col items-start gap-1">
            <Button
              variant="outline"
              disabled={transition.isPending || t.blockedByIndependentReview}
              onClick={() => {
                if (t.requiresEsignature) {
                  setPendingEsign({ category: t.category, label: `Move to ${t.name}` });
                } else {
                  doTransition(t.category);
                }
              }}
            >
              {t.requiresEsignature ? `Sign & move to ${t.name}` : `Move to ${t.name}`}
            </Button>
            {t.blockedByIndependentReview && (
              <p className="text-xs text-amber-700">
                Independent review required - someone other than you must approve this.
              </p>
            )}
          </div>
        ))}
        {allowedTransitions.data?.allowed.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No further transitions available{allowedTransitions.data?.fromCategory === "baselined" ? " - this version is baselined and frozen" : ""}.
          </p>
        )}
      </div>
      {transition.error && <p className="mt-2 text-sm text-destructive">{transition.error.message}</p>}

      <h2 className="mt-10 text-sm font-medium text-foreground">Version history</h2>
      <ul className="mt-2 divide-y divide-border overflow-hidden rounded-md border text-sm">
        {versions.map((v, i) => {
          // versions is newest-first (see the router's `orderBy(desc(versionNumber))`),
          // so the version "before" this one - what a redline compares against - is the
          // next entry in the array, not the previous one.
          const before = versions[i + 1] ?? null;
          const isExpanded = expandedVersionId === v.id;
          return (
            <li key={v.id}>
              <div className="flex items-center justify-between gap-3 px-3 py-2.5">
                <span>
                  <span className="font-mono text-xs font-semibold text-primary">v{v.versionNumber}</span> · {v.title}
                </span>
                <span className="flex items-center gap-2 text-muted-foreground">
                  {new Date(v.createdAt).toLocaleString()}
                  <StatusPill category={v.statusCategory} name={v.statusName} />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setExpandedVersionId(isExpanded ? null : v.id)}
                  >
                    {isExpanded ? "Hide changes" : "Show changes"}
                  </Button>
                </span>
              </div>
              {isExpanded && (
                <div className="px-3 pb-3">
                  <VersionDiff before={before} after={v} />
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {pendingEsign && (
        <EsignModal
          actionLabel={pendingEsign.label}
          onCancel={() => setPendingEsign(null)}
          onConfirm={async ({ typedName, reauthToken }) => {
            doTransition(pendingEsign.category, { typedName, reauthToken });
            setPendingEsign(null);
          }}
        />
      )}
      </main>
    </>
  );
}
