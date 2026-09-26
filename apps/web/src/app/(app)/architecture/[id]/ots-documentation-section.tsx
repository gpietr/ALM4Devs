"use client";

import { ArchitecturePicker } from "@/components/architecture-picker";
import { GenerateDocumentButton } from "@/components/generate-document-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc-client";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";
import { useEffect, useRef, useState } from "react";

// Standalone copy of @galm/core's OTS_CATEGORIES - its barrel pulls in the database layer.
const CATEGORIES = [
  { value: "operating_system", label: "Operating system" },
  { value: "driver", label: "Driver" },
  { value: "utility", label: "Utility" },
  { value: "library", label: "Library" },
  { value: "framework", label: "Framework" },
  { value: "runtime", label: "Runtime" },
  { value: "database", label: "Database" },
  { value: "cloud_service", label: "Cloud service" },
  { value: "firmware", label: "Firmware" },
  { value: "build_tool", label: "Build tool" },
  { value: "other", label: "Other" },
] as const;

const NO_CATEGORY = "none";

type TextKey =
  | "hostingEnvironment"
  | "endUserDocumentation"
  | "appropriatenessRationale"
  | "designLimitations"
  | "hardwareRequirements"
  | "softwareRequirements"
  | "installationConfiguration"
  | "configurationChangeFrequency"
  | "userTraining"
  | "nonSpecifiedSoftwarePrevention"
  | "intendedFunction"
  | "errorControlInvolvement"
  | "externalInterfaces"
  | "anomalyListUrl"
  | "updatesSourceUrl"
  | "versionControlMeasures"
  | "configurationManagement"
  | "storageLocation"
  | "installationVerification"
  | "maintenancePlan"
  | "riskAssessment"
  | "developmentAssurance"
  | "masterFileNumber"
  | "supportMechanism"
  | "retirementPlan";

interface FieldDef {
  key: TextKey;
  label: string;
  /** Single-line input instead of a textarea - URLs and identifiers. */
  short?: boolean;
  placeholder?: string;
}

interface Group {
  title: string;
  hint: string;
  enhanced?: boolean;
  /** Shows the "runs on" platform picker above the fields. */
  platforms?: boolean;
  fields: FieldDef[];
}

/** Follows section III of the FDA OTS guidance, in its order. Every field is optional. */
const GROUPS: Group[] = [
  {
    title: "What is it?",
    hint: "Title, manufacturer and version level are the item's own identity and version history. Also: documentation provided to the end user, why this OTS is appropriate for the product, and its expected design limitations.",
    fields: [
      { key: "endUserDocumentation", label: "OTS documentation provided to the end user" },
      { key: "appropriatenessRationale", label: "Why is this OTS software appropriate for this product?" },
      { key: "designLimitations", label: "Expected design limitations" },
    ],
  },
  {
    title: "Computer system specifications",
    platforms: true,
    hint: "For what configuration will the OTS software be validated? Hardware (processor, RAM, storage, communications, display) and software (OS, drivers, utilities - with exact versions and patches; link those as platform items so their recorded versions are used).",
    fields: [
      { key: "hardwareRequirements", label: "Hardware specifications" },
      { key: "softwareRequirements", label: "Software specifications (anything not covered by the platform items above)" },
      { key: "hostingEnvironment", label: "Hosting environment (e.g. hospital network, cloud) and for what function" },
    ],
  },
  {
    title: "How will you assure appropriate actions are taken by the end user?",
    hint: "What can or must be installed/configured and how, how often configuration changes, user training, and what prevents operation of non-specified OTS software (system design, preventive measures, documentation).",
    fields: [
      { key: "installationConfiguration", label: "What can / must be installed or configured, and the steps permitted or required" },
      { key: "configurationChangeFrequency", label: "How often will the configuration need to be changed?" },
      { key: "userTraining", label: "Education and training suggested or required for the user" },
      { key: "nonSpecifiedSoftwarePrevention", label: "Measures preventing the operation of non-specified OTS software" },
    ],
  },
  {
    title: "What does the OTS software do?",
    hint: "Which function it provides in this product, to what extent it's involved in error control and messaging, and its links with other software, including software outside the product (e.g. networks).",
    fields: [
      { key: "intendedFunction", label: "What is the OTS software intended to do in this product?" },
      { key: "errorControlInvolvement", label: "Involvement in error control and messaging" },
      { key: "externalInterfaces", label: "Links with other software, including outside the product" },
    ],
  },
  {
    title: "How do you know it works?",
    hint: "Testing evidence is the linked test cases (Details tab) and each version's assessment. The current list of known OTS bugs is the Known issues tab; record here where the vendor publishes them and where updates come from.",
    fields: [
      { key: "anomalyListUrl", label: "Vendor's known-bug list", short: true, placeholder: "https://…" },
      { key: "updatesSourceUrl", label: "Where updates are obtained", short: true, placeholder: "https://…" },
    ],
  },
  {
    title: "How will you keep track of (control) the OTS software?",
    hint: "Measures preventing incorrect versions (ideally a startup check of title, version and configuration that fails safe), configuration maintenance, storage, installation and life cycle support.",
    fields: [
      { key: "versionControlMeasures", label: "Measures preventing the introduction of incorrect versions" },
      { key: "configurationManagement", label: "How will you maintain the OTS software configuration?" },
      { key: "storageLocation", label: "Where and how will you store the OTS software?" },
      { key: "installationVerification", label: "How will you ensure proper installation?" },
      { key: "maintenancePlan", label: "How will you ensure proper maintenance and life cycle support?" },
    ],
  },
  {
    title: "Risk assessment",
    hint: "Risks associated with the functions of this OTS in the product, and how they're mitigated - or a reference to where your risk documentation covers them. Link risk-control requirements on the Details tab.",
    fields: [{ key: "riskAssessment", label: "OTS-related risks and their mitigation" }],
  },
  {
    title: "Assurance of development methodologies and continued maintenance",
    hint: "Usually only needed for higher-risk products. Assurance that the OTS developer's methodologies are appropriate (e.g. a review of their design and qualification documentation, or a master file the vendor filed with a regulator), and mechanisms for continued support if the developer changes or drops the OTS.",
    enhanced: true,
    fields: [
      { key: "developmentAssurance", label: "Assurance that the developer's methodologies are appropriate and sufficient" },
      { key: "masterFileNumber", label: "Vendor master file reference", short: true },
      { key: "supportMechanism", label: "Mechanisms for continued performance, maintenance and support" },
    ],
  },
];

type Draft = Record<TextKey, string> & {
  category: string;
  endOfSupportDate: string;
};

const ALL_TEXT_KEYS: TextKey[] = [...GROUPS.flatMap((g) => g.fields.map((f) => f.key)), "retirementPlan"];

/** Comparable snapshot of everything the form can change, for the dirty check. */
function snapshotOf(draft: Draft, platformIds: string[]): string {
  return JSON.stringify([draft, [...platformIds].sort()]);
}

/** One form, one Save; the completeness panel is informational only. */
export function OtsDocumentationSection({
  nodeId,
  productId,
  onDirtyChange,
}: {
  nodeId: string;
  productId: string;
  /** Lets the page confirm before switching tabs, which the unsaved-changes guard can't see. */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const utils = trpc.useUtils();
  const doc = trpc.ots.documentation.useQuery({ nodeId });
  const architectureOptions = trpc.architecture.listAllByProduct.useQuery({ productId });
  const updateProfile = trpc.ots.updateProfile.useMutation();
  const setPlatforms = trpc.ots.setPlatformLinks.useMutation();

  const [draft, setDraft] = useState<Draft | null>(null);
  const [platformIds, setPlatformIds] = useState<string[]>([]);
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(null);
  const hasInitializedRef = useRef(false);

  function syncFromServer(data: NonNullable<typeof doc.data>) {
    const { profile, platforms } = data;
    const next = {
      category: profile.category ?? NO_CATEGORY,
      endOfSupportDate: profile.endOfSupportDate ? new Date(profile.endOfSupportDate).toISOString().slice(0, 10) : "",
    } as Draft;
    for (const key of ALL_TEXT_KEYS) next[key] = profile[key] ?? "";
    const ids = platforms.map((p) => p.id);
    setDraft(next);
    setPlatformIds(ids);
    setSavedSnapshot(snapshotOf(next, ids));
  }

  useEffect(() => {
    hasInitializedRef.current = false;
  }, [nodeId]);

  useEffect(() => {
    if (!doc.data || hasInitializedRef.current) return;
    hasInitializedRef.current = true;
    syncFromServer(doc.data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.data]);

  // Computed above the loading returns - the guard and ⌘S handler are hooks.
  const isDirty = draft !== null && savedSnapshot !== null && snapshotOf(draft, platformIds) !== savedSnapshot;
  const pending = updateProfile.isPending || setPlatforms.isPending;
  useUnsavedChangesGuard(isDirty, "You have unsaved changes to this OTS documentation. Leave without saving?");
  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  async function save() {
    if (!draft) return;
    const fields: Record<string, unknown> = {
      category: draft.category === NO_CATEGORY ? null : draft.category,
      endOfSupportDate: draft.endOfSupportDate || null,
    };
    for (const key of ALL_TEXT_KEYS) fields[key] = draft[key];
    const snapshot = snapshotOf(draft, platformIds);
    await updateProfile.mutateAsync({ nodeId, fields: fields as Parameters<typeof updateProfile.mutateAsync>[0]["fields"] });
    await setPlatforms.mutateAsync({ nodeId, platformNodeIds: platformIds });
    setSavedSnapshot(snapshot);
    await Promise.all([utils.ots.documentation.invalidate({ nodeId }), utils.ots.register.invalidate()]);
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (isDirty && !pending) void save().catch(() => {});
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDirty, pending, draft, platformIds]);

  if (doc.error) return <p className="p-6 text-sm text-destructive">{doc.error.message}</p>;
  if (!doc.data || !draft) return <p className="p-6 text-sm text-muted-foreground">Loading...</p>;

  const { completeness } = doc.data;
  const platformOptions = (architectureOptions.data ?? []).filter((o) => o.kind === "ots" && o.id !== nodeId);
  const update = (patch: Partial<Draft>) => setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
  const error = updateProfile.error ?? setPlatforms.error;
  const mainGaps = completeness.gaps.filter((g) => !g.enhancedOnly);
  const enhancedGaps = completeness.gaps.filter((g) => g.enhancedOnly);

  return (
    <div className="mx-auto grid max-w-6xl gap-6 p-5 pb-24 lg:grid-cols-[1fr_300px]">
      <form
        className="min-w-0 space-y-6"
        onSubmit={(e) => {
          e.preventDefault();
          void save().catch(() => {});
        }}
      >
        <p className="text-[12.5px] text-muted-foreground">
          Every field is optional - fill in what applies to this OTS item.
        </p>

        <Label className="flex-col items-start gap-1 sm:max-w-xs">
          Category
          <Select value={draft.category} onValueChange={(v) => v && update({ category: v })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_CATEGORY}>Not set</SelectItem>
              {CATEGORIES.map((c) => (
                <SelectItem key={c.value} value={c.value}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Label>

        {GROUPS.map((group) => (
          <section key={group.title} className="space-y-3 border-t border-border pt-4">
            <div>
              <h2 className="text-[15px] font-medium">
                {group.title}
                {group.enhanced && (
                  <span className="ml-2 text-[11.5px] font-normal text-muted-foreground">(usually only for higher-risk products)</span>
                )}
              </h2>
              <p className="mt-1 text-[12px] text-muted-foreground">{group.hint}</p>
            </div>
            {group.platforms && (
              <Label className="flex-col items-start gap-1">
                <span className="text-[13px]">Runs on (OS, drivers, runtimes - other OTS items)</span>
                <ArchitecturePicker
                  options={platformOptions}
                  value={platformIds}
                  onChange={setPlatformIds}
                  placeholder="Add platform OTS item"
                  emptyMessage="No other OTS items in this product"
                />
              </Label>
            )}
            {group.fields.map((field) => (
              <Label key={field.key} className="flex-col items-start gap-1">
                <span className="text-[13px]">{field.label}</span>
                {field.short ? (
                  <Input
                    value={draft[field.key]}
                    placeholder={field.placeholder}
                    onChange={(e) => update({ [field.key]: e.target.value } as Partial<Draft>)}
                  />
                ) : (
                  <Textarea
                    rows={3}
                    value={draft[field.key]}
                    onChange={(e) => update({ [field.key]: e.target.value } as Partial<Draft>)}
                  />
                )}
              </Label>
            ))}
          </section>
        ))}

        <section className="space-y-3 border-t border-border pt-4">
          <div>
            <h2 className="text-[15px] font-medium">
              Maintenance and obsolescence
            </h2>
            <p className="mt-1 text-[12px] text-muted-foreground">
              Will the OTS still be available for products already in the field? Is there a retirement plan for components being
              replaced?
            </p>
          </div>
          <Label className="flex-col items-start gap-1 sm:max-w-xs">
            End of vendor support
            <Input type="date" value={draft.endOfSupportDate} onChange={(e) => update({ endOfSupportDate: e.target.value })} />
          </Label>
          <Label className="flex-col items-start gap-1">
            <span className="text-[13px]">Retirement / replacement plan</span>
            <Textarea rows={3} value={draft.retirementPlan} onChange={(e) => update({ retirementPlan: e.target.value })} />
          </Label>
        </section>

        {error && <p className="text-sm text-destructive">{error.message}</p>}

        {/* Fixed, same as the test case page: the form is long, so Save/Discard stay
            reachable from anywhere. The container's pb-24 keeps the last fields clear. */}
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card">
          <div className="flex items-center gap-2.5 px-5 py-3">
            <Button type="submit" disabled={pending || !isDirty}>
              {pending ? "Saving…" : "Save changes"}
              <span className="ml-1.5 border border-primary-foreground/45 px-1 font-mono text-[10px] font-normal normal-case">⌘S</span>
            </Button>
            <Button type="button" variant="outline" onClick={() => syncFromServer(doc.data!)} disabled={pending || !isDirty}>
              Discard
            </Button>
            {isDirty && <span className="ml-auto text-[13px] text-muted-foreground">Unsaved edits</span>}
          </div>
        </div>
      </form>

      <aside className="space-y-4 lg:sticky lg:top-4 lg:self-start">
        <div className="border border-border bg-card p-3">
          <div className="flex items-baseline justify-between">
            <p className="font-mono text-[10.5px] tracking-[0.1em] text-muted-foreground uppercase">Documented</p>
            <span className="font-mono text-[13px]">
              {completeness.filled}/{completeness.total}
            </span>
          </div>
          <p className="mt-1 text-[11.5px] text-muted-foreground">Informational only - nothing here blocks saving or export.</p>
          {mainGaps.length > 0 && (
            <ul className="mt-2.5 space-y-1.5 border-t border-border pt-2.5">
              {mainGaps.map((g) => (
                <li key={`${g.field}:${g.message}`} className="text-[12px]">
                  {g.message}
                </li>
              ))}
            </ul>
          )}
          {enhancedGaps.length > 0 && (
            <div className="mt-2.5 border-t border-border pt-2.5">
              <p className="text-[11px] text-muted-foreground">Usually only for higher-risk products:</p>
              <ul className="mt-1 space-y-1">
                {enhancedGaps.map((g) => (
                  <li key={g.field} className="text-[12px] text-muted-foreground">
                    {g.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <GenerateDocumentButton scope="ots_component" buildRequestBody={() => ({ architectureNodeId: nodeId })} />
      </aside>
    </div>
  );
}
