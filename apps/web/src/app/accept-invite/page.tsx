import { AcceptInviteForm } from "@/components/accept-invite-form";

export default async function AcceptInvitePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; tenant?: string }>;
}) {
  const { token, tenant } = await searchParams;

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-1">
          <p className="font-heading text-[18px] tracking-[0.08em] text-foreground">ALM4Devs</p>
          <h1 className="text-xl font-semibold tracking-tight">Accept invitation</h1>
          <p className="text-sm text-muted-foreground">Set your name and password to join the organization.</p>
        </div>

        {token && tenant ? (
          <AcceptInviteForm token={token} tenantId={tenant} />
        ) : (
          <p className="text-sm text-destructive">This invitation link is invalid.</p>
        )}

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
