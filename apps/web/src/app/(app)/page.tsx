import { auth } from "@/lib/auth";
import { TopBar } from "@/components/context-strip";
import { LastLocationRedirect } from "@/components/last-location-redirect";
import { buttonVariants } from "@/components/ui/button";
import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

// Layout already gates the (app) group, but this page also reads the session for the
// email/org line below - defend against a null session (e.g. DB blip between layout and
// page) so we redirect instead of throwing on `.user`.
//
// LastLocationRedirect (a client component) sends a returning user straight back to the
// product/artifact/level they were last looking at, if any is remembered - this page's own
// content below only ever shows on a first visit, or if nothing's remembered.
export default async function HomePage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/log-in");
  const user = session.user as { email: string; tenantId?: string };

  return (
    <>
      <LastLocationRedirect />
      <TopBar />
      <main className="mx-auto max-w-2xl px-4 py-10">
        <h1 className="font-heading text-[28px] leading-tight tracking-tight">ALM4Devs</h1>
        <p className="mt-1 text-sm text-muted-foreground">Signed in as {user.email}</p>
        <p className="text-sm text-muted-foreground">Organization id: {user.tenantId}</p>

        <div className="mt-10">
          <Link href="/products" className={buttonVariants({ size: "lg" })}>
            Go to Products →
          </Link>
        </div>
      </main>
    </>
  );
}
