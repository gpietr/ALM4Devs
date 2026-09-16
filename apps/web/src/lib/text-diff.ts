import { diffChars } from "diff";

/** Strips tags and decodes the handful of entities this app's rich-text sanitizer can
 * actually produce (see packages/core/src/rich-text.ts's allowlist) - good enough
 * without a full HTML parser. Inserts a space after block-level closing tags so adjacent
 * blocks don't run together (`<p>A</p><p>B</p>` -> "A B", not "AB"). Shared with
 * version-diff.tsx's redline view, which diffs at word granularity instead of character. */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<\/(p|li|div|h[1-6]|br|tr)\s*>/gi, "$& ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface TextDiffSegment {
  type: "unchanged" | "added" | "removed";
  text: string;
}

function toSegments(changes: ReturnType<typeof diffChars>): TextDiffSegment[] {
  return changes.map((c) => ({
    type: c.added ? "added" : c.removed ? "removed" : "unchanged",
    text: c.value,
  }));
}

/** Character-level diff of two rich-text HTML fields (`description`/`expectedResult`),
 * compared as plain text - a character diff over raw markup would split segments across
 * tag boundaries, which can't be rendered back as valid HTML. */
export function diffHtmlFieldsAsText(before: string, after: string): TextDiffSegment[] {
  return toSegments(diffChars(htmlToPlainText(before), htmlToPlainText(after)));
}

/** Same, for a plain-text field (`purpose`) - no HTML to strip. */
export function diffPlainText(before: string, after: string): TextDiffSegment[] {
  return toSegments(diffChars(before, after));
}
