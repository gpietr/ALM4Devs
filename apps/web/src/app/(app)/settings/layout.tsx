import { TopBar } from "@/components/context-strip";
import { SettingsShell } from "@/components/settings-shell";
import type { ReactNode } from "react";

/**
 * Shared chrome for every /settings/* route: TopBar (row 1 only) plus the settings side
 * rail. Individual pages used to each mount their own TopBar and a "← Settings" crumb;
 * that duplicated chrome and left the main /settings page as one long scroll of every
 * concern. Layout owns the shell; pages own only their section content.
 */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <TopBar />
      <SettingsShell>{children}</SettingsShell>
    </>
  );
}
