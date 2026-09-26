"use client";

import { useEffect, useRef } from "react";

let mermaidInit: Promise<typeof import("mermaid")> | null = null;
function mermaidApi() {
  if (!mermaidInit) {
    mermaidInit = import("mermaid").then((mod) => {
      mod.default.parseError = () => {};
      mod.default.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "neutral",
        layout: "dagre",
      });
      return mod;
    });
  }
  return mermaidInit;
}

function scrubMermaidTemp(id: string, sandbox?: HTMLElement, keep?: HTMLElement | null) {
  sandbox?.remove();
  for (const el of [document.getElementById(id), document.getElementById(`d${id}`), document.getElementById(`${id}-svg`)]) {
    if (el && !keep?.contains(el)) el.remove();
  }
}

export function MermaidPreview({ source }: { source: string }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.replaceChildren();
    if (!source.trim()) return;

    let cancelled = false;
    const renderId = `archdiag${Math.random().toString(36).slice(2)}`;
    const sandbox = document.createElement("div");
    sandbox.setAttribute("aria-hidden", "true");
    sandbox.style.cssText = "position:absolute;left:-9999px;top:0;width:0;height:0;overflow:hidden";
    document.body.appendChild(sandbox);

    (async () => {
      try {
        const mermaid = (await mermaidApi()).default;
        const { svg } = await mermaid.render(renderId, source, sandbox);
        if (cancelled) return;
        if (/syntax error/i.test(svg)) return;
        host.innerHTML = svg;
      } catch {
        // Keep the panel empty rather than mermaid's default error SVG, which it
        // otherwise appends to document.body (it showed up under the create form).
      } finally {
        scrubMermaidTemp(renderId, sandbox, host);
      }
    })();

    return () => {
      cancelled = true;
      scrubMermaidTemp(renderId, sandbox, host);
    };
  }, [source]);

  if (!source.trim()) {
    return <p className="text-xs text-muted-foreground">No diagram yet.</p>;
  }
  return (
    <div
      ref={hostRef}
      className="overflow-auto border border-border bg-background p-3 [&_svg]:mx-auto [&_svg]:max-w-full"
    />
  );
}
