"use client";

import { SettingsSectionHeader } from "@/components/settings-shell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc-client";
import { useIsOrgAdmin } from "@/lib/use-org-admin";
import { useState } from "react";

export default function GithubSettingsPage() {
  const utils = trpc.useUtils();
  const isOrgAdmin = useIsOrgAdmin();
  const connection = trpc.github.getConnection.useQuery();
  const saveConnection = trpc.github.saveConnection.useMutation({
    onSuccess: () => utils.github.getConnection.invalidate(),
  });
  const testConnection = trpc.github.testConnection.useMutation();

  const [token, setToken] = useState("");

  return (
    <div>
      <SettingsSectionHeader
        title="GitHub connection"
        description={
          <>
            Used to import known issues for OTS items from their GitHub issue lists. No token is required for public
            repositories (GitHub allows 10 anonymous searches per minute). A token raises that to 30 per minute and
            allows private repositories - a fine-grained token with read-only &quot;Issues&quot; access is enough.
          </>
        }
      />

      <Card className="max-w-2xl p-4">
        <h2 className="text-sm font-medium text-foreground">Connection</h2>
        {!isOrgAdmin && (
          <p className="mt-2 text-xs text-muted-foreground">
            Only organization admins can change the GitHub connection. Importing still works for everyone with whatever
            token is saved here.
          </p>
        )}
        <form
          className="mt-3 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            saveConnection.mutate({ token: token || undefined });
          }}
        >
          <Label className="flex-col items-start gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              Token {connection.data?.hasToken && "(leave blank to keep the saved one, or clear it below)"}
            </span>
            <Input type="password" disabled={!isOrgAdmin} value={token} onChange={(e) => setToken(e.target.value)} />
          </Label>
          <div className="flex items-center gap-2">
            <Button type="submit" disabled={!isOrgAdmin || saveConnection.isPending}>
              {saveConnection.isPending ? "Saving..." : "Save"}
            </Button>
            {connection.data?.hasToken && (
              <Button
                type="button"
                variant="outline"
                disabled={!isOrgAdmin || saveConnection.isPending}
                onClick={() => {
                  setToken("");
                  saveConnection.mutate({ token: null });
                }}
              >
                Clear token
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
            {connection.data.hasToken ? "A token is saved." : "No token saved - public repositories only, anonymous rate limit."}
          </p>
        )}
        {testConnection.data && (
          <p className="mt-2 text-sm text-emerald-700">
            Connected{testConnection.data.authenticated ? " with the saved token" : " anonymously"} -{" "}
            {testConnection.data.searchRemaining} of {testConnection.data.searchLimit} searches left this minute.
          </p>
        )}
        {testConnection.error && <p className="mt-2 text-sm text-destructive">{testConnection.error.message}</p>}
      </Card>
    </div>
  );
}
