"use client";

import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import { useState } from "react";

/** Used both on /register's "check your email" state and /log-in's "not verified" error. */
export function ResendVerificationButton({ email }: { email: string }) {
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");

  async function handleResend() {
    setStatus("sending");
    const { error } = await authClient.sendVerificationEmail({ email, callbackURL: "/" });
    setStatus(error ? "error" : "sent");
  }

  if (status === "sent") {
    return <p className="text-sm text-muted-foreground">Email sent - check your inbox.</p>;
  }

  return (
    <div className="space-y-1">
      <Button type="button" variant="outline" onClick={handleResend} disabled={status === "sending"}>
        {status === "sending" ? "Sending..." : "Resend verification email"}
      </Button>
      {status === "error" && <p className="text-sm text-destructive">Couldn&apos;t resend - try again shortly.</p>}
    </div>
  );
}
