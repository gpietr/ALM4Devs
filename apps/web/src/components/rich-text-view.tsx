/** Read-only rendering of a rich-text field already sanitized server-side (see
 * packages/core/src/rich-text.ts) - safe to render directly since nothing untrusted
 * reaches this component without passing through that sanitizer first. */
export function RichTextView({ html }: { html: string }) {
  // font-normal for the same reason as RichTextEditor's own wrapper - don't inherit an
  // ancestor's incidental font-weight (e.g. shadcn's Label, which defaults to font-medium).
  // eslint-disable-next-line react/no-danger
  return <div className="rte-content font-normal" dangerouslySetInnerHTML={{ __html: html }} />;
}
