"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function AcceptInviteForm({ token, tenantId }: { token: string; tenantId: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/accept-invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, tenantId, name, password }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string | { message?: string };
        };
        const message = typeof body.error === "string" ? body.error : body.error?.message;
        throw new Error(message ?? "Couldn't accept this invitation");
      }
      router.push("/");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't accept this invitation");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Label className="flex-col items-start gap-1">
        <span className="text-sm font-medium text-foreground">Your name</span>
        <Input required value={name} placeholder="Ada Lovelace" onChange={(e) => setName(e.target.value)} />
      </Label>
      <Label className="flex-col items-start gap-1">
        <span className="text-sm font-medium text-foreground">Password</span>
        <Input
          required
          type="password"
          value={password}
          placeholder="At least 8 characters"
          onChange={(e) => setPassword(e.target.value)}
        />
      </Label>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Button type="submit" disabled={submitting} className="w-full">
        {submitting ? "Joining..." : "Accept invitation"}
      </Button>
    </form>
  );
}
