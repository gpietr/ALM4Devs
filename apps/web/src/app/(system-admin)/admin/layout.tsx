import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

/**
 * Independent route group (sibling of (app), not nested under it) - system admins are
 * cross-tenant by design, so this needs its own session + isSystemAdmin gate rather than
 * inheriting (app)/layout.tsx's tenant-membership checks.
 */
export default async function SystemAdminLayout({ children }: { children: ReactNode }) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/log-in");
  if (!(session.user as { isSystemAdmin?: boolean }).isSystemAdmin) redirect("/");

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <div className="mb-8 flex items-baseline justify-between">
        <div>
          <p className="font-heading text-[18px] tracking-[0.08em] text-foreground">ALM4Devs</p>
          <h1 className="font-heading text-[22px] leading-none tracking-tight">System admin</h1>
        </div>
        <nav className="flex gap-4 text-sm">
          <Link href="/admin" className="text-muted-foreground hover:text-foreground">
            Tenants
          </Link>
          <Link href="/admin/users" className="text-muted-foreground hover:text-foreground">
            Users
          </Link>
          <Link href="/" className="text-muted-foreground hover:text-foreground">
            Back to app
          </Link>
        </nav>
      </div>
      {children}
    </div>
  );
}
