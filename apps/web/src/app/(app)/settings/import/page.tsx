"use client";

import { SettingsSectionHeader } from "@/components/settings-shell";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc-client";
import { useIsOrgAdmin } from "@/lib/use-org-admin";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

/**
 * The Spira import hub: connection setup only, plus navigation into the two actual import
 * screens (/settings/import/requirements, /settings/import/test-cases). Previously this
 * page held the connection form AND both entire import flows (target/mapping/preview/run,
 * twice) stacked on one long scroll - unwieldy on its own, and only getting longer as
 * mapping options grow (see the Legacy ID field added since). Split so each import job is
 * its own screen with its own URL, and the connection - shared by both - lives in exactly
 * one place instead of being re-editable from two.
 */
export default function SpiraImportHubPage() {
  const utils = trpc.useUtils();
  const isOrgAdmin = useIsOrgAdmin();
  const connection = trpc.spiraImport.getConnection.useQuery();
  const saveConnection = trpc.spiraImport.saveConnection.useMutation({
    onSuccess: () => utils.spiraImport.getConnection.invalidate(),
  });
  const testConnection = trpc.spiraImport.testConnection.useMutation();

  const [baseUrl, setBaseUrl] = useState("");
  const [apiVersion, setApiVersion] = useState("v6_0");
  const [username, setUsername] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [projectId, setProjectId] = useState("");

  useEffect(() => {
    if (connection.data) {
      setBaseUrl(connection.data.baseUrl);
      setApiVersion(connection.data.apiVersion);
      setUsername(connection.data.username);
      setProjectId(String(connection.data.projectId));
    }
  }, [connection.data]);

  return (
    <div>
      <SettingsSectionHeader
        title="Import from Spira"
        description={
          <>
            Save a connection here once, then import requirements and test cases from their own
            screens below — each is a one-time import — review the preview, then run it. Import
            all pages through the whole project automatically in one run.
          </>
        }
      />

      {/* --- Connection --- */}
      <Card className="p-4">
        <h3 className="text-sm font-medium text-foreground">Connection</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Base URL is the full path up to and including <code>RestService.svc</code> — copy
          it from your Spira instance&apos;s own REST API documentation page, since it
          differs between Cloud and self-hosted installs.
        </p>
        {!isOrgAdmin && (
          <p className="mt-2 text-xs text-muted-foreground">
            Only organization admins can change the Spira connection. Importing still works for
            everyone using the connection saved here.
          </p>
        )}
        <form
          className="mt-3 grid grid-cols-2 gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            saveConnection.mutate({
              baseUrl,
              apiVersion,
              username,
              apiKey: apiKey || undefined,
              projectId: Number(projectId),
            });
          }}
        >
          <Label className="col-span-2 flex-col items-start gap-1">
            <span className="text-xs font-medium text-muted-foreground">Base URL</span>
            <Input
              required
              disabled={!isOrgAdmin}
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://mycompany.spiraservice.net/Spira/Services/v6_0/RestService.svc"
            />
          </Label>
          <Label className="flex-col items-start gap-1">
            <span className="text-xs font-medium text-muted-foreground">API version</span>
            <Input required disabled={!isOrgAdmin} value={apiVersion} onChange={(e) => setApiVersion(e.target.value)} />
          </Label>
          <Label className="flex-col items-start gap-1">
            <span className="text-xs font-medium text-muted-foreground">Project ID (numeric)</span>
            <Input required type="number" disabled={!isOrgAdmin} value={projectId} onChange={(e) => setProjectId(e.target.value)} />
          </Label>
          <Label className="flex-col items-start gap-1">
            <span className="text-xs font-medium text-muted-foreground">Username</span>
            <Input required disabled={!isOrgAdmin} value={username} onChange={(e) => setUsername(e.target.value)} />
          </Label>
          <Label className="flex-col items-start gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              API key {connection.data?.hasApiKey && "(leave blank to keep the saved one)"}
            </span>
            <Input type="password" disabled={!isOrgAdmin} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
          </Label>
          <div className="col-span-2 flex items-center gap-2">
            <Button type="submit" disabled={!isOrgAdmin || saveConnection.isPending}>
              {saveConnection.isPending ? "Saving..." : "Save connection"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={!isOrgAdmin || testConnection.isPending || !connection.data}
              onClick={() => testConnection.mutate()}
            >
              {testConnection.isPending ? "Testing..." : "Test connection"}
            </Button>
          </div>
        </form>
        {saveConnection.error && <p className="mt-2 text-sm text-destructive">{saveConnection.error.message}</p>}
        {testConnection.isSuccess && (
          <p className="mt-2 text-sm text-emerald-700">Connected - project: {testConnection.data.projectName}</p>
        )}
        {testConnection.error && <p className="mt-2 text-sm text-destructive">{testConnection.error.message}</p>}
      </Card>

      {/* --- Where to go next --- */}
      <div className="mt-8 grid gap-3 sm:grid-cols-2">
        <Link
          href="/settings/import/requirements"
          className="group flex flex-col justify-between border border-border bg-card p-4 hover:bg-muted/50"
        >
          <div>
            <h3 className="text-sm font-medium text-foreground">Import requirements</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Map Title, Description, and optional fields; choose the product and level.
            </p>
          </div>
          <span className={buttonVariants({ variant: "outline", size: "sm", className: "mt-3 w-fit" })}>
            Go <ArrowRight className="ml-1 size-3.5" />
          </span>
        </Link>
        <Link
          href="/settings/import/test-cases"
          className="group flex flex-col justify-between border border-border bg-card p-4 hover:bg-muted/50"
        >
          <div>
            <h3 className="text-sm font-medium text-foreground">Import test cases</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Map Title and optional fields; every step&apos;s Description and Expected
              Result import automatically.
            </p>
          </div>
          <span className={buttonVariants({ variant: "outline", size: "sm", className: "mt-3 w-fit" })}>
            Go <ArrowRight className="ml-1 size-3.5" />
          </span>
        </Link>
      </div>
    </div>
  );
}
