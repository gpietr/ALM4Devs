"use client";

import { SettingsSectionHeader } from "@/components/settings-shell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc-client";
import { useIsOrgAdmin } from "@/lib/use-org-admin";
import { useState } from "react";

/**
 * Per-tenant, optional NVD API key backing OTS vulnerability scanning (see the "OTS"
 * view on the Architecture tab). Unlike the AI/Spira connections, no key is a fully
 * working configuration - NVD's public rate limit (5 requests/30s) still works with
 * nothing saved here; a key just raises that to 50/30s. Same shape otherwise: never
 * echoed back, a "Test connection" button before you trust it.
 */
export default function NvdSettingsPage() {
  const utils = trpc.useUtils();
  const isOrgAdmin = useIsOrgAdmin();
  const connection = trpc.vulnerabilities.getConnection.useQuery();
  const saveConnection = trpc.vulnerabilities.saveConnection.useMutation({
    onSuccess: () => utils.vulnerabilities.getConnection.invalidate(),
  });
  const testConnection = trpc.vulnerabilities.testConnection.useMutation();

  const [apiKey, setApiKey] = useState("");

  return (
    <div>
      <SettingsSectionHeader
        title="NVD connection"
        description={
          <>
            Used to scan OTS (off-the-shelf) architecture items against the National Vulnerability Database. No key is
            required - NVD&apos;s public rate limit (5 requests per 30 seconds) works out of the box. Adding a free NVD
            API key raises that to 50 requests per 30 seconds, which speeds up scans (especially &quot;Scan all&quot;).
          </>
        }
      />

      <Card className="max-w-2xl p-4">
        <h2 className="text-sm font-medium text-foreground">Connection</h2>
        {!isOrgAdmin && (
          <p className="mt-2 text-xs text-muted-foreground">
            Only organization admins can change the NVD connection. Scanning still works for
            everyone with whatever key is saved here.
          </p>
        )}
        <form
          className="mt-3 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            saveConnection.mutate({ apiKey: apiKey || undefined });
          }}
        >
          <Label className="flex-col items-start gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              API key {connection.data?.hasApiKey && "(leave blank to keep the saved one, or clear it below)"}
            </span>
            <Input type="password" disabled={!isOrgAdmin} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
          </Label>
          <div className="flex items-center gap-2">
            <Button type="submit" disabled={!isOrgAdmin || saveConnection.isPending}>
              {saveConnection.isPending ? "Saving..." : "Save"}
            </Button>
            {connection.data?.hasApiKey && (
              <Button
                type="button"
                variant="outline"
                disabled={!isOrgAdmin || saveConnection.isPending}
                onClick={() => {
                  setApiKey("");
                  saveConnection.mutate({ apiKey: null });
                }}
              >
                Clear key
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              disabled={!isOrgAdmin || testConnection.isPending}
              onClick={() => testConnection.mutate()}
            >
              {testConnection.isPending ? "Testing..." : "Test connection"}
            </Button>
          </div>
        </form>
        {saveConnection.error && <p className="mt-2 text-sm text-destructive">{saveConnection.error.message}</p>}
        {connection.data && (
          <p className="mt-2 text-[12.5px] text-muted-foreground">
            {connection.data.hasApiKey ? "A key is saved." : "No key saved - using NVD's public rate limit."}
          </p>
        )}
        {testConnection.isSuccess && <p className="mt-2 text-sm text-emerald-700">Connected.</p>}
        {testConnection.error && <p className="mt-2 text-sm text-destructive">{testConnection.error.message}</p>}
      </Card>
    </div>
  );
}
