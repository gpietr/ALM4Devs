import type { ReactNode } from "react";
import "./globals.css";
import { Providers } from "./providers";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Barlow, Barlow_Condensed, IBM_Plex_Mono } from "next/font/google";
import { cn } from "@/lib/utils";

// Barlow/Barlow Condensed + IBM Plex Mono - the shell-restructure design handoff's
// "technical/wireframe" pairing (design_handoff_shell_restructure/README.md), replacing
// the earlier IBM Plex Sans body face. Self-hosted at build time via next/font (no
// runtime CDN request - this product ships as a self-host Docker image, so a viewer never
// makes an outbound request to Google Fonts). Condensed carries every heading/label/
// button (--font-heading); Barlow is body text (--font-sans); mono stays exactly what it
// was - every identifier (item ids, versions, level codes, status tags), never UI chrome.
const barlow = Barlow({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-sans",
});
const barlowCondensed = Barlow_Condensed({
  subsets: ["latin"],
  weight: ["600"],
  variable: "--font-heading",
});
const ibmPlexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
});

export const metadata = {
  title: "ALM4Devs",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={cn("font-sans", barlow.variable, barlowCondensed.variable, ibmPlexMono.variable)}>
      <body>
        <Providers>
          <TooltipProvider>
            {children}
            {/* Image upload validation errors from the rich-text editor (see
                minimal-tiptap's Image extension) surface via sonner toasts - without this
                mounted, those calls are silent no-ops. */}
            <Toaster />
          </TooltipProvider>
        </Providers>
      </body>
    </html>
  );
}
