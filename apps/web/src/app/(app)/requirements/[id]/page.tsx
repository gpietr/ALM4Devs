"use client";

import { ProductContextStrip } from "@/components/context-strip";
import { EsignModal } from "@/components/esign-modal";
import {
  asCustomFieldDefinitions,
  customFieldFormStateFromValues,
  type CustomFieldFormState,
  CustomFieldInputs,
  CustomFieldReadout,
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
  const deleteRequirement = trpc.requirements.delete.useMutation();

  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [background, setBackground] = useState("");
  const [pendingEsign, setPendingEsign] = useState<{ category: string; label: string } | null>(null);
  const [expandedVersionId, setExpandedVersionId] = useState<string | null>(null);
  const [customFieldState, setCustomFieldState] = useState<CustomFieldFormState>({});

  // Open a draft straight into the edit form (title, description, background, and
  // tenant-defined fields together). Approved/in-review land read-only; approved can
  // still be opened into edit, and that save is what creates the next version. Guarded
  // by a ref so a refetch after save doesn't stomp in-progress edits.
  const hasInitializedRef = useRef(false);
  useEffect(() => {
    if (hasInitializedRef.current || !detail.data) return;
    const latest = detail.data.versions[0];
    if (!latest) return;
    hasInitializedRef.current = true;
    setTitle(latest.title);
    setDescription(latest.description);
    setBackground(latest.background ?? "");
    setCustomFieldState(customFieldFormStateFromValues(detail.data.customFieldValues));
    if (latest.statusCategory === "draft") setEditing(true);
  }, [detail.data]);

  if (detail.isLoading) return <main className="mx-auto max-w-4xl px-5 py-16 text-[13.5px] text-muted-foreground">Loading...</main>;
  if (detail.error) return <main className="mx-auto max-w-4xl px-5 py-16 text-sm text-destructive">{detail.error.message}</main>;
  if (!detail.data) return null;

  const { requirement, versions, children, coveringTestCases, customFieldValues } = detail.data;
  const current = versions[0];
  if (!current) return null;

  function startEditing() {
    setTitle(current!.title);
    setDescription(current!.description);
    setBackground(current!.background ?? "");
    setCustomFieldState(customFieldFormStateFromValues(customFieldValues));
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
      <main className="mx-auto max-w-4xl px-5 py-8">
      <Link
        href={`/products/${requirement.productId}?artifact=requirements&level=${requirement.levelId}`}
        className="text-[13px] text-muted-foreground hover:text-foreground"
      >
        ← Back to {requirement.levelName}
      </Link>
      <div className="mt-4 flex items-start justify-between">
        <div>
          <p className="font-mono text-[10.5px] tracking-[0.14em] text-muted-foreground uppercase">
            <span className="font-medium text-foreground">
              {formatItemId(requirement.levelCode, requirement.sequenceNumber)}
            </span>{" "}
            · {requirement.levelName}
          </p>
          <h1 className="mt-1 font-heading text-[28px] leading-tight tracking-tight">{current.title}</h1>
          {requirement.parentTitle && requirement.parentRequirementId && (
            <p className="mt-1 text-[13.5px] text-muted-foreground">
              Traces to{" "}
              <Link
                href={`/requirements/${requirement.parentRequirementId}`}
                className="text-foreground hover:underline"
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
        {/* One form: title, description, background, and tenant-defined fields. A draft
            Save updates the current version in place; saving an approved requirement
            is what inserts the next version. */}
        {editing ? (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              editDraft.mutate({
                requirementId: id,
                title,
                description,
                background: background || undefined,
                customFieldValues: toCustomFieldValuesInput(customFieldState),
              });
            }}
          >
            <Input required value={title} onChange={(e) => setTitle(e.target.value)} />
            <Textarea required value={description} onChange={(e) => setDescription(e.target.value)} rows={4} />
            <Label className="flex-col items-start gap-1">
              <span className="text-xs font-medium text-muted-foreground">Background (optional)</span>
              <RichTextEditor value={background} onChange={setBackground} />
            </Label>
            <CustomFieldInputs
              fields={customFieldDefs}
              state={customFieldState}
              onChange={(fieldId, value) => setCustomFieldState((s) => ({ ...s, [fieldId]: value }))}
            />
            {editDraft.error && <p className="text-sm text-destructive">{editDraft.error.message}</p>}
            <div className="flex gap-2">
              <Button type="submit" disabled={editDraft.isPending}>
                {editDraft.isPending
                  ? "Saving..."
                  : current.statusCategory === "approved"
                    ? "Save new version"
                    : "Save"}
              </Button>
              {current.statusCategory !== "draft" && (
                <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              )}
            </div>
          </form>
        ) : (
          <div className="space-y-3">
            <p className="whitespace-pre-wrap text-sm text-foreground/90">{current.description}</p>
            {current.background && (
              <div className="border-t pt-4">
                <p className="text-xs font-medium text-muted-foreground">Background</p>
                <RichTextView html={current.background} />
              </div>
            )}
            <CustomFieldReadout values={customFieldValues} />
            {current.statusCategory === "approved" ? (
              <Button variant="outline" size="sm" onClick={startEditing}>
                Edit (new version)
              </Button>
            ) : current.statusCategory === "draft" ? (
              <Button variant="outline" size="sm" onClick={startEditing}>
                Edit
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">
                This version is {current.statusName.toLowerCase()} and locked for editing - see the available
                transitions below.
              </p>
            )}
          </div>
        )}
      </Card>

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
