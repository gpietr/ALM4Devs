"use client";

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
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const { error: signInError } = await authClient.signIn.email({ email, password });
    setSubmitting(false);
    if (signInError) {
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
