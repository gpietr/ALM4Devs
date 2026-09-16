import sanitizeHtml from "sanitize-html";

/**
 * The one place every rich-text field (test step description/expectedResult/purpose,
 * step-execution actualResult) must pass through before it's persisted. HTML was chosen
 * as the storage format - "images, tables, other simple formatting, like Spira" - partly
 * because it's the natural bridge to Spira's own HTML-based rich-text fields when the
 * Spira importer (backlog item 8) is actually built, not just because it's what the
 * editor (Tiptap, apps/web) happens to produce.
 *
 * Never trust client-supplied HTML directly - this is what actually enforces that, not
 * just "the editor wouldn't let you type a <script> tag" (a client can always bypass the
 * UI and call the API directly).
 */
export function sanitizeRichText(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      "p",
      "br",
      "strong",
      "b",
      "em",
      "i",
      "u",
      "s",
      "h1",
      "h2",
      "h3",
      "ul",
      "ol",
      "li",
      "blockquote",
      "code",
      "pre",
      "a",
      "img",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
    ],
    allowedAttributes: {
      a: ["href", "target", "rel"],
      img: ["src", "alt", "width", "height"],
      th: ["colspan", "rowspan"],
      td: ["colspan", "rowspan"],
    },
    allowedSchemes: ["http", "https", "data"],
    // Images embedded via the editor point at our own /api/attachments/[id] (relative
    // URL, no scheme) - allowing relative URLs is what lets that through.
    allowProtocolRelative: false,
  });
}
