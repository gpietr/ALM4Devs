"use client";

import { diffWords } from "diff";

/** Rough plain-text approximation for diffing purposes only - background is rich HTML
 * (tables/images survive in the real rendered view elsewhere), but a redline diff over
 * markup would just be full of tag noise. Good enough to show what changed, not meant to
 * be a faithful re-render. */
function stripHtmlForDiff(html: string): string {
  return html
    .replace(/<\/(p|li|div|h[1-6]|br|tr)\s*>/gi, "$& ")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function DiffText({ oldText, newText }: { oldText: string; newText: string }) {
  if (oldText === newText) {
    return <p className="text-sm text-muted-foreground">No change.</p>;
  }
  const parts = diffWords(oldText, newText);
  return (
    <p className="whitespace-pre-wrap text-sm leading-relaxed">
      {parts.map((part, i) =>
        part.added ? (
          <ins key={i} className="rounded-sm bg-emerald-100 px-0.5 text-emerald-800 no-underline">
            {part.value}
          </ins>
        ) : part.removed ? (
          <del key={i} className="rounded-sm bg-red-100 px-0.5 text-red-800">
            {part.value}
          </del>
        ) : (
          <span key={i}>{part.value}</span>
        ),
      )}
    </p>
  );
}

export interface DiffableVersion {
  title: string;
  description: string;
  background: string | null;
}

/** A Spira-style redline: what changed between the version before this one and this one,
 * field by field, word-level added/removed highlighting. `before` is null for the very
 * first version - nothing to diff against, so it's shown as the starting content instead. */
export function VersionDiff({ before, after }: { before: DiffableVersion | null; after: DiffableVersion }) {
  if (!before) {
    return (
      <div className="space-y-3 rounded-md border border-border bg-muted/30 p-3">
        <p className="text-xs text-muted-foreground">Initial version - nothing to compare against.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-md border border-border bg-muted/30 p-3">
      {before.title !== after.title && (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Title</p>
          <DiffText oldText={before.title} newText={after.title} />
        </div>
      )}
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Description</p>
        <DiffText oldText={before.description} newText={after.description} />
      </div>
      {(before.background || after.background) && (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Background</p>
          <DiffText
            oldText={stripHtmlForDiff(before.background ?? "")}
            newText={stripHtmlForDiff(after.background ?? "")}
          />
        </div>
      )}
    </div>
  );
}
