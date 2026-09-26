"use client";

import { CpePickerDialog } from "@/components/cpe-picker-dialog";
import { SoftwareVersionLinkList } from "@/components/software-version-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc-client";
import type { AppRouter } from "@/server/routers/_app";
import type { inferRouterOutputs } from "@trpc/server";
import { useState } from "react";
import { OtsVersionControls } from "./ots-version-controls";

type Detail = inferRouterOutputs<AppRouter>["architecture"]["get"];

/** Version history, new versions, scans, release tags, support status and assessment.
 * Each control saves on its own. */
export function OtsVersionsTab({ detail }: { detail: Detail }) {
  const { node, versionHistory } = detail;
  const nodeId = node.id;
  const utils = trpc.useUtils();

  const recordVersion = trpc.vulnerabilities.recordVersion.useMutation({
    onSuccess: () => {
      utils.architecture.get.invalidate({ id: nodeId });
      utils.architecture.listByProduct.invalidate();
      utils.ots.register.invalidate();
      // A version bump changes whether existing findings still count as "confirmed under
      // the current version" (see getVulnerabilitiesForNode) - without this, the
      // Vulnerabilities tab would keep showing pre-bump staleness state until some other
      // action happened to refetch it.
      utils.vulnerabilities.listForNode.invalidate({ nodeId });
    },
  });
  const scanVersion = trpc.vulnerabilities.scanNode.useMutation({
    onSuccess: () => utils.vulnerabilities.listForNode.invalidate({ nodeId }),
  });
  const [scanningVersionId, setScanningVersionId] = useState<string | null>(null);
  const setVersionSoftwareVersions = trpc.architecture.setVersionSoftwareVersions.useMutation({
    onSuccess: () => utils.architecture.get.invalidate({ id: nodeId }),
  });
  const softwareVersionOptions = trpc.softwareVersions.listByProduct.useQuery({ productId: node.productId });

  const [recordingVersion, setRecordingVersion] = useState(false);
  const [newVersion, setNewVersion] = useState("");
  const [newCpe, setNewCpe] = useState("");
  const [newReleaseDate, setNewReleaseDate] = useState("");
  const [newPatchLevel, setNewPatchLevel] = useState("");
  const [newUpgradeDesignation, setNewUpgradeDesignation] = useState("");
  const [newReleaseNotesUrl, setNewReleaseNotesUrl] = useState("");
  const [copyLinksFromPrevious, setCopyLinksFromPrevious] = useState(false);
  const [cpePickerOpen, setCpePickerOpen] = useState(false);

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

  return (
    <div className="space-y-4 pb-24">
      <div className="flex items-start justify-between gap-4">
        <p className="max-w-2xl text-[12.5px] text-muted-foreground">
          Adding a new version keeps the old one in history (with its own CPE) rather than editing it in place - that&apos;s
          what keeps a scan from ever silently matching a stale version.
        </p>
        {!recordingVersion && (
          <Button type="button" size="sm" onClick={() => setRecordingVersion(true)}>
            {node.currentVersion ? "Add new version" : "Add version"}
          </Button>
        )}
      </div>

      {recordingVersion && (
        <form
          className="space-y-2 border border-border bg-card p-3"
          onSubmit={(e) => {
            e.preventDefault();
            recordVersion.mutate(
              {
                nodeId,
                version: newVersion,
                cpe: newCpe || undefined,
                releaseDate: newReleaseDate || undefined,
                patchLevel: newPatchLevel || undefined,
                upgradeDesignation: newUpgradeDesignation || undefined,
                releaseNotesUrl: newReleaseNotesUrl || undefined,
                copyLinksFromVersionId: copyLinksFromPrevious && node.currentVersion ? node.currentVersion.id : undefined,
              },
              { onSuccess: resetNewVersionForm },
            );
          }}
        >
          <p className="font-mono text-[10.5px] tracking-[0.1em] text-muted-foreground uppercase">New version</p>
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
              Used for a precise NVD vulnerability match when set; otherwise scans fall back to a supplier/version keyword
              search.
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
            <Input value={newReleaseNotesUrl} onChange={(e) => setNewReleaseNotesUrl(e.target.value)} placeholder="https://…" />
          </Label>
          {node.currentVersion && (
            <Label>
              <Checkbox checked={copyLinksFromPrevious} onCheckedChange={(checked) => setCopyLinksFromPrevious(checked)} />
              <span className="text-[13px]">Copy &ldquo;applies to versions&rdquo; links from {node.currentVersion.version}</span>
            </Label>
          )}
          {recordVersion.error && <p className="text-sm text-destructive">{recordVersion.error.message}</p>}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={recordVersion.isPending || !newVersion.trim()}>
              {recordVersion.isPending ? "Adding…" : "Add"}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={resetNewVersionForm}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {/* Outside the form: the picker has its own <form>, and React submit events bubble
          through portals to the enclosing one. */}
      <CpePickerDialog
        open={cpePickerOpen}
        onOpenChange={setCpePickerOpen}
        initialKeyword={[node.supplier, node.title, newVersion].filter(Boolean).join(" ")}
        onSelect={setNewCpe}
      />

      {versionHistory.length === 0 ? (
        <p className="text-[13.5px] text-muted-foreground">No version added yet.</p>
      ) : (
        // Every version is shown, not just the current one behind a "history" disclosure
        // - a past version is still directly scannable (NVD doesn't care which one is
        // "current" for you), so it stays visible alongside the current one.
        <ul className="border-t border-border">
          {versionHistory.map((v) => {
            const isCurrent = v.id === node.currentVersion?.id;
            return (
              <li key={v.id} className="space-y-1.5 border-b border-border py-3 text-[12.5px]">
                <div className="flex items-center justify-between gap-2">
                  <span>
                    <span className={`font-mono text-[13px] ${isCurrent ? "font-medium text-foreground" : "text-muted-foreground"}`}>
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
                        { nodeId, versionId: isCurrent ? undefined : v.id },
                        { onSettled: () => setScanningVersionId(null) },
                      );
                    }}
                  >
                    {scanningVersionId === v.id ? "Scanning…" : "Scan"}
                  </Button>
                </div>
                {/* Which releases shipped with this exact component version - e.g.
                    "Log4j 2.14.1 shipped in v1.0". Saves immediately on change. */}
                <SoftwareVersionLinkList
                  options={softwareVersionOptions.data ?? []}
                  value={v.softwareVersions.map((sv) => sv.id)}
                  onChange={(softwareVersionIds) =>
                    setVersionSoftwareVersions.mutate({ nodeId, architectureNodeVersionId: v.id, softwareVersionIds })
                  }
                  addLabel="Applies to versions"
                />
                <OtsVersionControls nodeId={nodeId} productId={node.productId} versionId={v.id} supportStatus={v.supportStatus} />
              </li>
            );
          })}
        </ul>
      )}
      {scanVersion.error && <p className="text-sm text-destructive">{scanVersion.error.message}</p>}
      {setVersionSoftwareVersions.error && <p className="text-sm text-destructive">{setVersionSoftwareVersions.error.message}</p>}
    </div>
  );
}
