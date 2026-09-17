"use client";

import { SettingsSectionHeader } from "@/components/settings-shell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { trpc } from "@/lib/trpc-client";
import { useEffect, useState } from "react";

type Provider = "anthropic" | "openai" | "openai_compatible";

/**
 * Per-tenant "bring your own AI provider" connection, backing AI-assisted test step
 * drafting (see /test-cases pages' "Draft with AI" button). Same shape as the Spira
 * connection form (/settings/import) - one saved connection, never echoed back, an empty
 * key on save keeps the existing one, a "Test connection" button before you trust it.
 * No Vercel account involved - each provider's own SDK package calls that provider's own
 * API directly with the key entered here.
 */
export default function AiSettingsPage() {
  const utils = trpc.useUtils();
  const connection = trpc.llm.getConnection.useQuery();
  const saveConnection = trpc.llm.saveConnection.useMutation({
    onSuccess: () => utils.llm.getConnection.invalidate(),
  });
  const testConnection = trpc.llm.testConnection.useMutation();

  const [provider, setProvider] = useState<Provider>("anthropic");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");

  useEffect(() => {
    if (connection.data) {
      setProvider(connection.data.provider as Provider);
      setModel(connection.data.model);
      setBaseUrl(connection.data.baseUrl ?? "");
    }
  }, [connection.data]);

  return (
    <div>
      <SettingsSectionHeader
        title="AI connection"
        description={
          <>
            Used to draft and revise test steps by chatting with it (see the &quot;Draft with
            AI&quot; button on a test case&apos;s Steps section). Bring your own key — Anthropic
            and OpenAI call that provider&apos;s own API directly; &quot;OpenAI-compatible&quot;
            covers a self-hosted endpoint (Ollama, vLLM) or a third-party one (Groq, Together,
            DeepSeek, etc) via a custom base URL. Nothing here goes through a Vercel account or
            any hosted gateway.
          </>
        }
      />

      <Card className="max-w-2xl p-4">
          <h2 className="text-sm font-medium text-foreground">Connection</h2>
          <form
            className="mt-3 grid grid-cols-2 gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              saveConnection.mutate({
                provider,
                model,
                baseUrl: provider === "openai_compatible" ? baseUrl : undefined,
                apiKey: apiKey || undefined,
              });
            }}
          >
            <Label className="flex-col items-start gap-1">
              <span className="text-xs font-medium text-muted-foreground">Provider</span>
              <Select value={provider} onValueChange={(v) => setProvider(v as Provider)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="anthropic">Anthropic</SelectItem>
                  <SelectItem value="openai">OpenAI</SelectItem>
                  <SelectItem value="openai_compatible">OpenAI-compatible (custom base URL)</SelectItem>
                </SelectContent>
              </Select>
            </Label>
            <Label className="flex-col items-start gap-1">
              <span className="text-xs font-medium text-muted-foreground">Model</span>
              <Input
                required
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={provider === "anthropic" ? "claude-sonnet-5" : provider === "openai" ? "gpt-5" : "llama-3.3-70b"}
              />
            </Label>
            {provider === "openai_compatible" && (
              <Label className="col-span-2 flex-col items-start gap-1">
                <span className="text-xs font-medium text-muted-foreground">Base URL</span>
                <Input
                  required
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://your-endpoint.example.com/v1"
                />
              </Label>
            )}
            <Label className="col-span-2 flex-col items-start gap-1">
              <span className="text-xs font-medium text-muted-foreground">
                API key {connection.data?.hasApiKey && "(leave blank to keep the saved one)"}
              </span>
              <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
            </Label>
            <div className="col-span-2 flex items-center gap-2">
              <Button type="submit" disabled={saveConnection.isPending}>
                {saveConnection.isPending ? "Saving..." : "Save connection"}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={testConnection.isPending || !connection.data}
                onClick={() => testConnection.mutate()}
              >
                {testConnection.isPending ? "Testing..." : "Test connection"}
              </Button>
            </div>
          </form>
          {saveConnection.error && <p className="mt-2 text-sm text-destructive">{saveConnection.error.message}</p>}
          {testConnection.isSuccess && <p className="mt-2 text-sm text-emerald-700">Connected.</p>}
          {testConnection.error && <p className="mt-2 text-sm text-destructive">{testConnection.error.message}</p>}
        </Card>
    </div>
  );
}
