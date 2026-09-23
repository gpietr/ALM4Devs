"use client";

import { ResendVerificationButton } from "@/components/resend-verification-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useRouter } from "next/navigation";
import { useState } from "react";

export default function RegisterPage() {
  const router = useRouter();
  const [orgName, setOrgName] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pendingVerificationEmail, setPendingVerificationEmail] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgName, name, email, password }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string | { message?: string };
        };
        const message =
          typeof body.error === "string" ? body.error : body.error?.message;
        throw new Error(message ?? "Registration failed");
      }
      // REQUIRE_EMAIL_VERIFICATION=true withholds the session (`token: null` in the
      // response body) until the emailed link is clicked - show a "check your email" state
      // instead of the dashboard in that case. Off (the default), `token` is set and this
      // behaves exactly as it always has.
      const body = (await res.json().catch(() => ({}))) as { token?: string | null };
      if (!body.token) {
        setPendingVerificationEmail(email);
        return;
      }
      router.push("/");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed");
    } finally {
      setSubmitting(false);
    }
  }

  if (pendingVerificationEmail) {
    return (
      <main className="flex min-h-screen items-center justify-center px-4">
        <div className="w-full max-w-sm space-y-4 text-center">
          <p className="font-heading text-[18px] tracking-[0.08em] text-foreground">ALM4Devs</p>
          <h1 className="text-xl font-semibold tracking-tight">Check your email</h1>
          <p className="text-sm text-muted-foreground">
            We sent a verification link to <span className="font-medium text-foreground">{pendingVerificationEmail}</span>.
            Click it to finish setting up your account.
          </p>
          <ResendVerificationButton email={pendingVerificationEmail} />
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-1">
          <p className="font-heading text-[18px] tracking-[0.08em] text-foreground">ALM4Devs</p>
          <h1 className="text-xl font-semibold tracking-tight">Create your organization</h1>
          <p className="text-sm text-muted-foreground">
            One account for your team&apos;s requirements and test management.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Field label="Organization name" value={orgName} onChange={setOrgName} placeholder="Acme Medical" />
          <Field label="Your name" value={name} onChange={setName} placeholder="Ada Lovelace" />
          <Field
            label="Email"
            type="email"
            value={email}
            onChange={setEmail}
            placeholder="ada@acme-medical.com"
          />
          <Field
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            placeholder="At least 8 characters"
          />

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button type="submit" disabled={submitting} className="w-full">
            {submitting ? "Creating account..." : "Create account"}
          </Button>
        </form>

        <p className="text-center text-sm text-muted-foreground">
          Already have an account?{" "}
          <a href="/log-in" className="font-medium text-foreground underline underline-offset-2">
            Log in
          </a>
        </p>
      </div>
    </main>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <Label className="flex-col items-start gap-1">
      <span className="text-sm font-medium text-foreground">{label}</span>
      <Input required type={type} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </Label>
  );
}
