"use client";

import { ResendVerificationButton } from "@/components/resend-verification-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import { useRouter } from "next/navigation";
import { useState } from "react";

export default function LogInPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [needsVerification, setNeedsVerification] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNeedsVerification(false);
    setSubmitting(true);
    const { error: signInError } = await authClient.signIn.email({ email, password });
    setSubmitting(false);
    if (signInError) {
      // Only reachable when REQUIRE_EMAIL_VERIFICATION=true (apps/web/src/lib/auth.ts) -
      // better-auth blocks sign-in for an unverified account with this specific code.
      if (signInError.code === "EMAIL_NOT_VERIFIED") {
        setNeedsVerification(true);
        return;
      }
      setError(signInError.message ?? "Log in failed");
      return;
    }
    router.push("/");
    router.refresh();
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-1">
          <p className="font-heading text-[18px] tracking-[0.08em] text-foreground">ALM4Devs</p>
          <h1 className="text-xl font-semibold tracking-tight">Log in</h1>
          <p className="text-sm text-muted-foreground">Welcome back.</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Label className="flex-col items-start gap-1">
            <span className="text-sm font-medium text-foreground">Email</span>
            <Input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Label>
          <Label className="flex-col items-start gap-1">
            <span className="text-sm font-medium text-foreground">Password</span>
            <Input required type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Label>

          {error && <p className="text-sm text-destructive">{error}</p>}
          {needsVerification && (
            <div className="space-y-2 rounded-md border border-border p-3">
              <p className="text-sm text-foreground">
                Your email isn&apos;t verified yet. Check your inbox for the verification link.
              </p>
              <ResendVerificationButton email={email} />
            </div>
          )}

          <Button type="submit" disabled={submitting} className="w-full">
            {submitting ? "Logging in..." : "Log in"}
          </Button>
        </form>

        <p className="text-center text-sm text-muted-foreground">
          Need an account?{" "}
          <a href="/register" className="font-medium text-foreground underline underline-offset-2">
            Create your organization
          </a>
        </p>
      </div>
    </main>
  );
}
