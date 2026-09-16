import type { ReactNode } from "react";
import "./globals.css";
import { Providers } from "./providers";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import { cn } from "@/lib/utils";

// IBM Plex Sans/Mono, not Geist (shadcn's init default) or Inter (the generic "safe"
// choice) - a deliberate pairing, self-hosted at build time via next/font (no runtime CDN
// request, which matters more here than for a one-off Artifact mockup since this product
// ships as a self-host Docker image). Mono is for identifiers - requirement/test-case ids,
// version numbers - not for UI chrome.
const ibmPlexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
});
const ibmPlexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
});

export const metadata = {
  title: "galm",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={cn("font-sans", ibmPlexSans.variable, ibmPlexMono.variable)}>
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
