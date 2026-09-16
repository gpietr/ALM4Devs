"use client";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useState } from "react";

/**
 * The e-signature UI for TECH_STACK.md's re-authentication design: collects a typed name
 * and password, exchanges the password for a short-lived re-auth token via /api/reauth,
 * then hands both to the caller to include in the actual transition mutation.
 *
 * Built on shadcn's Dialog (Base UI underneath) rather than the hand-rolled fixed-overlay
 * `<div>` this used to be - a real accessibility gap that fixes: focus trap, Escape to
 * close, `aria-modal`, all for free instead of hand-implemented.
 */
export function EsignModal({
  actionLabel,
  onCancel,
  onConfirm,
}: {
  actionLabel: string;
  onCancel: () => void;
  onConfirm: (args: { typedName: string; reauthToken: string }) => Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const [typedName, setTypedName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/reauth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const body = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
      if (!res.ok || !body.token) {
        throw new Error(body.error ?? "Re-authentication failed");
      }
      await onConfirm({ typedName, reauthToken: body.token });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>E-signature required</DialogTitle>
          <DialogDescription>
            Confirm &ldquo;{actionLabel}&rdquo; by typing your name and re-entering your password.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <Label className="flex-col items-start gap-1.5">
            Typed name
            <Input required value={typedName} onChange={(e) => setTypedName(e.target.value)} />
          </Label>
          <Label className="flex-col items-start gap-1.5">
            Password
            <Input required type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Label>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Signing..." : "Sign & confirm"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
