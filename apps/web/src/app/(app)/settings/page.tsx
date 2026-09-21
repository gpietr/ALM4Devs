import { buttonVariants } from "@/components/ui/button";
import { ArrowRight } from "lucide-react";
import Link from "next/link";

/**
 * Settings landing: a hub of section cards (same idea as /settings/import's requirements
 * vs test-cases cards), not the former dump of every editor on one scroll. The side rail
 * in SettingsShell is how you jump between sections day-to-day; this page is the map.
 */
const SECTIONS: ReadonlyArray<{
  group: string;
  items: ReadonlyArray<{ href: string; title: string; description: string }>;
}> = [
  {
    group: "Workflow",
    items: [
      {
        href: "/settings/approval",
        title: "Approval",
        description: "E-signature and independent review for Approved / Baselined.",
      },
      {
        href: "/settings/statuses",
        title: "Statuses",
        description: "Rename, reorder, or disable workflow statuses.",
      },
    ],
  },
  {
    group: "Structure",
    items: [
      {
        href: "/settings/requirement-levels",
        title: "Requirement levels",
        description: "Hierarchy levels and id-prefix codes (e.g. SYSREQ).",
      },
      {
        href: "/settings/architecture-levels",
        title: "Architecture levels",
        description: "System vs software architecture, or one level per software.",
      },
      {
        href: "/settings/test-levels",
        title: "Test case levels",
        description: "Organize test cases the same way as requirements.",
      },
    ],
  },
  {
    group: "Fields & docs",
    items: [
      {
        href: "/settings/custom-fields",
        title: "Custom fields",
        description: "Extra fields on every requirement, test case, or test run.",
      },
      {
        href: "/settings/document-templates",
        title: "Document templates",
        description: "HTML templates for PDFs from test cases, runs, or requirement lists.",
      },
    ],
  },
  {
    group: "Integrations",
    items: [
      {
        href: "/settings/ai",
        title: "AI connection",
        description: "Bring-your-own key for drafting test steps.",
      },
      {
        href: "/settings/import",
        title: "Import",
        description: "One-time import of requirements and test cases from Spira.",
      },
      {
        href: "/settings/nvd",
        title: "NVD connection",
        description: "Optional API key to speed up OTS vulnerability scans.",
      },
    ],
  },
];

export default function SettingsOverviewPage() {
  return (
    <div>
      <header className="mb-8">
        <h2 className="font-heading text-[28px] leading-tight tracking-tight">All settings</h2>
        <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">
          Tenant-wide configuration. Pick a section below, or use the rail on the left.
        </p>
      </header>

      <div className="space-y-8">
        {SECTIONS.map((section) => (
          <section key={section.group}>
            <h3 className="mb-3 font-mono text-[10.5px] tracking-[0.1em] text-muted-foreground uppercase">
              {section.group}
            </h3>
            <div className="grid gap-3 sm:grid-cols-2">
              {section.items.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="group flex flex-col justify-between border border-border bg-card p-4 transition-colors hover:bg-muted/50"
                >
                  <div>
                    <h4 className="text-sm font-medium text-foreground">{item.title}</h4>
                    <p className="mt-1 text-xs text-muted-foreground">{item.description}</p>
                  </div>
                  <span
                    className={buttonVariants({
                      variant: "outline",
                      size: "sm",
                      className: "mt-3 w-fit",
                    })}
                  >
                    Open <ArrowRight className="ml-1 size-3.5" />
                  </span>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
