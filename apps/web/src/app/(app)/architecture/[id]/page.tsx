"use client";

import { ProductContextStrip } from "@/components/context-strip";
import { CpePickerDialog } from "@/components/cpe-picker-dialog";
import { RequirementPicker } from "@/components/requirement-picker";
import { TestCasePicker } from "@/components/architecture-picker";
import { SoftwareVersionLinkList } from "@/components/software-version-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc-client";
import { useUrlState } from "@/lib/use-url-state";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useEffect, useRef, useState } from "react";
import { OtsAnomaliesSection } from "./ots-anomalies-section";
import { OtsDocumentationSection } from "./ots-documentation-section";
import { OtsVersionControls } from "./ots-version-controls";
import { VulnerabilitiesSection } from "./vulnerabilities-section";

const KIND_LABEL = {
  software_item: "Software item",
  software_unit: "Software unit",
  ots: "OTS",
} as const;

const NO_PARENT = "none";

// OTS-only tabs beyond Details.
const OTS_TABS = [
  { value: "documentation", label: "Documentation" },
  { value: "anomalies", label: "Known issues" },
  { value: "vulnerabilities", label: "Vulnerabilities" },
] as const;
type OtsTab = (typeof OTS_TABS)[number]["value"];

export default function ArchitectureDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const utils = trpc.useUtils();
  const { searchParams, setParams } = useUrlState();
  const detail = trpc.architecture.get.useQuery({ id });
  const updateNode = trpc.architecture.update.useMutation({
    onSuccess: () => {
      utils.architecture.get.invalidate({ id });
      utils.architecture.listTrace.invalidate();
      utils.architecture.listByProduct.invalidate();
    },
  });
  const deleteNode = trpc.architecture.delete.useMutation();

  const recordVersion = trpc.vulnerabilities.recordVersion.useMutation({
    onSuccess: () => {
      utils.architecture.get.invalidate({ id });
      utils.architecture.listByProduct.invalidate();
      // A version bump changes whether existing findings still count as "confirmed under
      // the current version" (see getVulnerabilitiesForNode) - without this, the
      // Vulnerabilities section below would keep showing pre-bump staleness state until
      // some other action happened to refetch it.
      utils.vulnerabilities.listForNode.invalidate({ nodeId: id });
    },
  });

  const scanVersion = trpc.vulnerabilities.scanNode.useMutation({
    onSuccess: () => {
      utils.vulnerabilities.listForNode.invalidate({ nodeId: id });
    },
  });
  const [scanningVersionId, setScanningVersionId] = useState<string | null>(null);

  const setVersionSoftwareVersions = trpc.architecture.setVersionSoftwareVersions.useMutation({
    onSuccess: () => utils.architecture.get.invalidate({ id }),
  });
  const softwareVersionOptions = trpc.softwareVersions.listByProduct.useQuery(
    { productId: detail.data?.node.productId ?? "" },
    { enabled: !!detail.data?.node.productId },
  );

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [parentId, setParentId] = useState<string>(NO_PARENT);
  const [parentTouched, setParentTouched] = useState(false);
  const [supplier, setSupplier] = useState("");
  const [recordingVersion, setRecordingVersion] = useState(false);
  const [newVersion, setNewVersion] = useState("");
  const [newCpe, setNewCpe] = useState("");
  const [newReleaseDate, setNewReleaseDate] = useState("");
  const [newPatchLevel, setNewPatchLevel] = useState("");
  const [newUpgradeDesignation, setNewUpgradeDesignation] = useState("");
  const [newReleaseNotesUrl, setNewReleaseNotesUrl] = useState("");
  const [copyLinksFromPrevious, setCopyLinksFromPrevious] = useState(false);
  const [cpePickerOpen, setCpePickerOpen] = useState(false);
  const [requirementIds, setRequirementIds] = useState<string[]>([]);
  const [testCaseIds, setTestCaseIds] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  const [documentationDirty, setDocumentationDirty] = useState(false);
  const hasInitializedRef = useRef(false);

  const productId = detail.data?.node.productId;
  const requirementOptions = trpc.requirements.listAllByProduct.useQuery(
    { productId: productId! },
    { enabled: !!productId },
  );
  const testCaseOptions = trpc.testCases.listAllByProduct.useQuery(
    { productId: productId! },
    { enabled: !!productId },
  );

  useEffect(() => {
    hasInitializedRef.current = false;
    setReady(false);
    setParentTouched(false);
  }, [id]);

  useEffect(() => {
    if (!detail.data || hasInitializedRef.current) return;
    hasInitializedRef.current = true;
    const { node, parent, requirementLinks, testCaseLinks } = detail.data;
    setTitle(node.title);
    setDescription(node.description);
    setParentId(parent?.id ?? NO_PARENT);
    setSupplier(node.supplier ?? "");
    setRequirementIds(requirementLinks.map((l) => l.id));
    setTestCaseIds(testCaseLinks.map((l) => l.id));
    setReady(true);
  }, [detail.data]);

  if (detail.error) {
    return <p className="p-6 text-sm text-destructive">{detail.error.message}</p>;
  }
  if (detail.isLoading || !ready || !detail.data) {
    return <p className="p-6 text-sm text-muted-foreground">Loading...</p>;
  }

  const { node, children, parentOptions, canBeRoot, versionHistory } = detail.data;
  const displayId = node.displayId;
  const kind = node.kind as keyof typeof KIND_LABEL;
  // Non-OTS nodes always render Details, whatever ?tab= says.
  const tabParam = searchParams.get("tab");
  const tab: OtsTab | "details" =
    kind === "ots" && OTS_TABS.some((t) => t.value === tabParam) ? (tabParam as OtsTab) : "details";

  function resetNewVersionForm() {
    setRecordingVersion(false);
    setNewVersion("");
    setNewCpe("");
    setNewReleaseDate("");
    setNewPatchLevel("");
    setNewUpgradeDesignation("");
    setNewReleaseNotesUrl("");
    setCopyLinksFromPrevious(false);
  }

  function save() {
    const input: {
      id: string;
      title: string;
      description: string;
      parentId?: string | null;
      supplier?: string | null;
      requirementIds: string[];
      testCaseIds: string[];
    } = { id, title, description, requirementIds, testCaseIds };
    if (parentTouched) {
      if (parentId !== NO_PARENT) input.parentId = parentId;
      else if (canBeRoot) input.parentId = null;
    }
    if (kind === "ots") {
      input.supplier = supplier || null;
    }
    updateNode.mutate(input);
  }

  return (
    <>
      <ProductContextStrip productId={node.productId} artifact="architecture" activeLevelId={node.levelId} />

      <div className="flex items-center justify-between border-b border-border bg-card px-5 py-[9px]">
        <span className="font-mono text-xs text-muted-foreground">
          <Link
            href={`/products/${node.productId}?artifact=architecture&level=${node.levelId}`}
            className="hover:text-foreground"
          >
            {node.levelCode}
          </Link>{" "}
          <span className="opacity-50">/</span> <span className="font-medium text-foreground">{displayId} - {node.title}</span>
        </span>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          disabled={deleteNode.isPending}
          onClick={() => {
            if (!confirm(`Delete ${displayId}?`)) return;
            deleteNode.mutate(
              { id },
              {
                onSuccess: () => {
                  router.push(`/products/${node.productId}?artifact=architecture&level=${node.levelId}`);
                },
              },
            );
          }}
        >
          {deleteNode.isPending ? "Deleting..." : "Delete"}
        </Button>
      </div>
      {deleteNode.error && <p className="px-5 pt-2 text-sm text-destructive">{deleteNode.error.message}</p>}

      {kind === "ots" && (
        <div className="border-b border-border bg-card px-5 py-2">
          <div className="flex w-fit border border-border bg-background text-[13px]">
            <button
              type="button"
              className={`px-3 py-1.5 ${tab === "details" ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"}`}
              onClick={() => {
                if (tab === "details") return;
                if (documentationDirty && !confirm("You have unsaved changes to this OTS documentation. Leave without saving?")) return;
                setDocumentationDirty(false);
                setParams({ tab: undefined });
              }}
            >
              Details
            </button>
            {OTS_TABS.map((t) => (
              <button
                key={t.value}
                type="button"
                className={`px-3 py-1.5 ${tab === t.value ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"}`}
                onClick={() => {
                  if (t.value === tab) return;
                  if (documentationDirty && !confirm("You have unsaved changes to this OTS documentation. Leave without saving?")) return;
                  setDocumentationDirty(false);
                  setParams({ tab: t.value });
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {tab === "vulnerabilities" ? (
        <VulnerabilitiesSection nodeId={id} />
      ) : tab === "documentation" ? (
        <OtsDocumentationSection nodeId={id} productId={node.productId} onDirtyChange={setDocumentationDirty} />
      ) : tab === "anomalies" ? (
        <OtsAnomaliesSection nodeId={id} productId={node.productId} />
      ) : (
      <form
        className="mx-auto max-w-3xl space-y-5 p-5 pb-24"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div className="flex items-start gap-3.5 border-b border-border pb-3.5">
          <span className="mt-1.5 bg-foreground px-1.5 py-0.5 font-mono text-[13px] font-medium text-background">
            {displayId}
          </span>
          <div className="min-w-0 flex-1">
            <Input
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="h-auto border-0 bg-transparent p-0 font-heading text-[28px] leading-tight tracking-tight focus-visible:ring-0"
            />
            <div className="mt-1.5 flex items-center gap-2">
              <Badge variant="outline">{KIND_LABEL[kind]}</Badge>
            </div>
          </div>
        </div>

        <Label className="flex-col items-start gap-1">
          Parent
          <Select
            value={parentId}
            onValueChange={(v) => {
              if (!v) return;
              setParentId(v);
              setParentTouched(true);
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {canBeRoot && <SelectItem value={NO_PARENT}>Level root</SelectItem>}
              {parentOptions.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.displayId} {option.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Label>

        <Label className="flex-col items-start gap-1">
          Description
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={6} />
        </Label>

        {kind === "ots" && (
          <div className="space-y-4">
            <Label className="flex-col items-start gap-1">
              Supplier
              <Input value={supplier} onChange={(e) => setSupplier(e.target.value)} />
            </Label>

            <div className="border border-border p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="font-mono text-[10.5px] tracking-[0.1em] text-muted-foreground uppercase">Versions</p>
                {!recordingVersion && (
                  <Button type="button" size="sm" variant="outline" onClick={() => setRecordingVersion(true)}>
                    {node.currentVersion ? "Add new version" : "Add version"}
                  </Button>
                )}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Adding a new version keeps the old one in history (with its own CPE) rather than editing it in
                place - that's what keeps a scan from ever silently matching a stale version.
              </p>

              {recordingVersion && (
                // A plain div, not a nested <form> - this whole block already sits inside
                // the page's main <form onSubmit={save}> (nested <form> elements are
                // invalid HTML; the browser silently flattens them, so a type="submit"
                // button in here would never actually fire this section's own submit
                // logic). The "Add" button below calls the mutation directly instead.
                <div className="mt-3 space-y-2 border-t border-border pt-3">
                  <Label className="flex-col items-start gap-1">
                    Version
                    <Input required value={newVersion} onChange={(e) => setNewVersion(e.target.value)} />
                  </Label>
                  <Label className="flex-col items-start gap-1">
                    CPE
                    <div className="flex w-full gap-2">
                      <Input
                        value={newCpe}
                        onChange={(e) => setNewCpe(e.target.value)}
                        placeholder="cpe:2.3:a:vendor:product:version:*:*:*:*:*:*:*"
                        className="font-mono text-[12.5px]"
                      />
                      <Button type="button" variant="outline" onClick={() => setCpePickerOpen(true)}>
                        Find CPE
                      </Button>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      Used for a precise NVD vulnerability match when set; otherwise scans fall back to a
                      supplier/version keyword search.
                    </span>
                  </Label>
                  {/* Optional; fixed once recorded, like the CPE. */}
                  <div className="grid gap-2 sm:grid-cols-3">
                    <Label className="flex-col items-start gap-1">
                      Release date
                      <Input type="date" value={newReleaseDate} onChange={(e) => setNewReleaseDate(e.target.value)} />
                    </Label>
                    <Label className="flex-col items-start gap-1">
                      Patch number
                      <Input value={newPatchLevel} onChange={(e) => setNewPatchLevel(e.target.value)} />
                    </Label>
                    <Label className="flex-col items-start gap-1">
                      Upgrade designation
                      <Input value={newUpgradeDesignation} onChange={(e) => setNewUpgradeDesignation(e.target.value)} />
                    </Label>
                  </div>
                  <Label className="flex-col items-start gap-1">
                    Release notes URL
                    <Input
                      value={newReleaseNotesUrl}
                      onChange={(e) => setNewReleaseNotesUrl(e.target.value)}
                      placeholder="https://…"
                    />
                  </Label>
                  {node.currentVersion && (
                    <Label>
                      <Checkbox
                        checked={copyLinksFromPrevious}
                        onCheckedChange={(checked) => setCopyLinksFromPrevious(checked)}
                      />
                      <span className="text-[13px]">
                        Copy &ldquo;applies to versions&rdquo; links from {node.currentVersion.version}
                      </span>
                    </Label>
                  )}
                  {recordVersion.error && <p className="text-sm text-destructive">{recordVersion.error.message}</p>}
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      disabled={recordVersion.isPending || !newVersion.trim()}
                      onClick={() =>
                        recordVersion.mutate(
                          {
                            nodeId: id,
                            version: newVersion,
                            cpe: newCpe || undefined,
                            releaseDate: newReleaseDate || undefined,
                            patchLevel: newPatchLevel || undefined,
                            upgradeDesignation: newUpgradeDesignation || undefined,
                            releaseNotesUrl: newReleaseNotesUrl || undefined,
                            copyLinksFromVersionId:
                              copyLinksFromPrevious && node.currentVersion ? node.currentVersion.id : undefined,
                          },
                          { onSuccess: resetNewVersionForm },
                        )
                      }
                    >
                      {recordVersion.isPending ? "Adding…" : "Add"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={resetNewVersionForm}
                    >
                      Cancel
                    </Button>
                  </div>
                  <CpePickerDialog
                    open={cpePickerOpen}
                    onOpenChange={setCpePickerOpen}
                    initialKeyword={[supplier, title, newVersion].filter(Boolean).join(" ")}
                    onSelect={setNewCpe}
                  />
                </div>
              )}

              {versionHistory.length === 0 ? (
                <p className="mt-3 text-[13.5px] text-muted-foreground">No version added yet.</p>
              ) : (
                // Every version is shown here, not just the current one behind a
                // "history" disclosure - a past version is still directly scannable (NVD
                // doesn't care which one is "current" for you), so it stays visible
                // alongside the current one instead of being tucked away.
                <ul className="mt-3 space-y-1.5 border-t border-border pt-3">
                  {versionHistory.map((v) => {
                    const isCurrent = v.id === node.currentVersion?.id;
                    return (
                      <li key={v.id} className="space-y-1 text-[12.5px]">
                        <div className="flex items-center justify-between gap-2">
                          <span>
                            <span className={isCurrent ? "font-medium text-foreground" : "text-muted-foreground"}>
                              {v.version}
                            </span>{" "}
                            {v.patchLevel && <span className="text-muted-foreground">patch {v.patchLevel} </span>}
                            {v.upgradeDesignation && <span className="text-muted-foreground">({v.upgradeDesignation}) </span>}
                            {v.cpe && <span className="font-mono text-[11px] text-muted-foreground">{v.cpe}</span>}{" "}
                            <span className="text-muted-foreground">
                              {v.releaseDate && `· released ${new Date(v.releaseDate).toLocaleDateString()} `}· recorded{" "}
                              {new Date(v.createdAt).toLocaleDateString()}
                            </span>
                            {isCurrent && (
                              <Badge variant="outline" className="ml-1.5">
                                current
                              </Badge>
                            )}
                          </span>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={scanningVersionId === v.id}
                            onClick={() => {
                              setScanningVersionId(v.id);
                              scanVersion.mutate(
                                { nodeId: id, versionId: isCurrent ? undefined : v.id },
                                { onSettled: () => setScanningVersionId(null) },
                              );
                            }}
                          >
                            {scanningVersionId === v.id ? "Scanning…" : "Scan"}
                          </Button>
                        </div>
                        {/* Which releases shipped with this exact component version -
                            e.g. "Log4j 2.14.1 shipped in v1.0". Saves immediately on
                            change (no separate button) since this is a standalone tag,
                            not part of the page's own Save form. */}
                        <SoftwareVersionLinkList
                          options={softwareVersionOptions.data ?? []}
                          value={v.softwareVersions.map((sv) => sv.id)}
                          onChange={(softwareVersionIds) =>
                            setVersionSoftwareVersions.mutate({
                              nodeId: id,
                              architectureNodeVersionId: v.id,
                              softwareVersionIds,
                            })
                          }
                          addLabel="Applies to versions"
                        />
                        <OtsVersionControls
                          nodeId={id}
                          productId={node.productId}
                          versionId={v.id}
                          supportStatus={v.supportStatus}
                        />
                      </li>
                    );
                  })}
                </ul>
              )}
              {scanVersion.error && <p className="mt-1.5 text-sm text-destructive">{scanVersion.error.message}</p>}
              {setVersionSoftwareVersions.error && (
                <p className="mt-1.5 text-sm text-destructive">{setVersionSoftwareVersions.error.message}</p>
              )}
            </div>
          </div>
        )}

        <Label className="flex-col items-start gap-1">
          <span className="text-xs font-medium text-muted-foreground">Linked requirements</span>
          <RequirementPicker
            options={requirementOptions.data ?? []}
            value={requirementIds}
            onChange={setRequirementIds}
          />
        </Label>

        <Label className="flex-col items-start gap-1">
          <span className="text-xs font-medium text-muted-foreground">Linked test cases</span>
          <TestCasePicker options={testCaseOptions.data ?? []} value={testCaseIds} onChange={setTestCaseIds} />
        </Label>

        {children.length > 0 && (
          <div>
            <p className="mb-1.5 font-mono text-[10.5px] tracking-[0.1em] text-muted-foreground uppercase">Children</p>
            <ul className="space-y-1">
              {children.map((child) => (
                <li key={child.id}>
                  <Link href={`/architecture/${child.id}`} className="font-mono text-[13px] hover:text-primary">
                    {child.displayId}
                  </Link>{" "}
                  <span className="text-[13.5px]">{child.title}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {updateNode.error && <p className="text-sm text-destructive">{updateNode.error.message}</p>}

        <div className="flex gap-2">
          <Button type="submit" disabled={updateNode.isPending}>
            {updateNode.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
      )}
    </>
  );
}
