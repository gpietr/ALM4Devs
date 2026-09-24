import { SignOutButton } from "@/components/sign-out-button";

const MESSAGES: Record<string, string> = {
  removed: "Your access to this organization has been removed.",
  suspended: "Your organization's access is currently suspended.",
};

export default async function AccessBlockedPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const { reason } = await searchParams;
  const message = (reason && MESSAGES[reason]) ?? "You no longer have access to this application.";

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6 text-center">
        <div className="space-y-1">
          <p className="font-heading text-[18px] tracking-[0.08em] text-foreground">ALM4Devs</p>
          <h1 className="text-xl font-semibold tracking-tight">Access blocked</h1>
          <p className="text-sm text-muted-foreground">{message}</p>
        </div>
        <SignOutButton />
      </div>
    </main>
  );
}
