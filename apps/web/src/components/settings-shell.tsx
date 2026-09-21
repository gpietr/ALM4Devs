"use client";

import { cn } from "cn";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/**
 * Persistent settings chrome: a left rail of section links (grouped the way the product
 * strip groups artifact tabs + LEVEL), wrapping every /settings/* page so configuration
 * isn't one endless scroll and you don't have to bounce back to a hub between sections.
 * Active state mirrors the product strip's primary underline - here a left border + ink.
 */
const NAV_GROUPS: ReadonlyArray<{
  label: string;
  items: ReadonlyArray<{ href: string; label: string; match: (pathname: string) => boolean }>;
}> = [
  {
    label: "Overview",
    items: [
      {
        href: "/settings",
        label: "All settings",
        match: (p) => p === "/settings",
      },
    ],
  },
  {
    label: "Workflow",
    items: [
      {
        href: "/settings/approval",
        label: "Approval",
        match: (p) => p === "/settings/approval",
      },
      {
        href: "/settings/statuses",
        label: "Statuses",
        match: (p) => p === "/settings/statuses",
      },
    ],
  },
  {
    label: "Structure",
    items: [
      {
        href: "/settings/requirement-levels",
        label: "Requirement levels",
        match: (p) => p === "/settings/requirement-levels",
      },
      {
        href: "/settings/architecture-levels",
        label: "Architecture levels",
        match: (p) => p === "/settings/architecture-levels",
      },
      {
        href: "/settings/test-levels",
        label: "Test case levels",
        match: (p) => p === "/settings/test-levels",
      },
    ],
  },
  {
    label: "Fields & docs",
    items: [
      {
        href: "/settings/custom-fields",
        label: "Custom fields",
        match: (p) => p === "/settings/custom-fields",
      },
      {
        href: "/settings/document-templates",
        label: "Document templates",
        match: (p) => p === "/settings/document-templates",
      },
    ],
  },
  {
    label: "Integrations",
    items: [
      {
        href: "/settings/ai",
        label: "AI connection",
        match: (p) => p === "/settings/ai",
      },
      {
        href: "/settings/import",
        label: "Import",
        match: (p) => p.startsWith("/settings/import"),
      },
      {
        href: "/settings/nvd",
        label: "NVD connection",
        match: (p) => p === "/settings/nvd",
      },
    ],
  },
];

export function SettingsShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8 md:flex-row md:gap-0 md:py-0">
      <aside className="shrink-0 md:w-52 md:border-r md:border-border md:py-10 md:pr-5">
        <div className="mb-4 flex items-baseline justify-between gap-3 md:mb-6 md:block">
          <h1 className="font-heading text-[22px] leading-none tracking-tight md:text-[26px]">Settings</h1>
          <Link
            href="/"
            className="text-[12px] text-muted-foreground hover:text-foreground md:mt-2 md:block"
          >
            Back home
          </Link>
        </div>

        <nav className="flex gap-4 overflow-x-auto pb-1 md:block md:space-y-5 md:overflow-visible md:pb-0">
          {NAV_GROUPS.map((group) => (
            <div key={group.label} className="shrink-0">
              <p className="mb-1.5 font-mono text-[10.5px] tracking-[0.1em] text-muted-foreground uppercase">
                {group.label}
              </p>
              <ul className="flex gap-1 md:block md:space-y-0.5">
                {group.items.map((item) => {
                  const active = item.match(pathname);
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        className={cn(
                          "block border-b-2 px-2 py-1.5 font-heading text-[12.5px] tracking-[0.08em] uppercase md:border-b-0 md:border-l-2 md:px-3",
                          active
                            ? "border-primary text-foreground"
                            : "border-transparent text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
      </aside>

      <div className="min-w-0 flex-1 md:px-8 md:py-10">{children}</div>
    </div>
  );
}

/** Shared title block for a settings section page - keeps h1/description grammar consistent
 * once the shell owns the page chrome. */
export function SettingsSectionHeader({
  title,
  description,
}: {
  title: string;
  description: ReactNode;
}) {
  return (
    <header className="mb-8">
      <h2 className="font-heading text-[28px] leading-tight tracking-tight">{title}</h2>
      <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">{description}</p>
    </header>
  );
}
