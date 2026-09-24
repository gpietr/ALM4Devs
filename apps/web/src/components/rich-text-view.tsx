/** Read-only rendering of a rich-text field already sanitized server-side (see
 * packages/core/src/rich-text.ts) - safe to render directly since nothing untrusted
 * reaches this component without passing through that sanitizer first.
 *
 * That invariant is the caller's job, and it covers more than the write path: anything
 * rendered here that came from *outside* has to be sanitized before it's sent, even when
 * it's never persisted. The two that do this are testCases.suggestSteps (model output)
 * and spiraImport.preview/previewTestCases (a remote Spira instance's HTML) - both
 * sanitize in their tRPC procedure. If you add another source of un-persisted rich text,
 * it belongs on that list. */
export function RichTextView({ html }: { html: string }) {
  // font-normal for the same reason as RichTextEditor's own wrapper - don't inherit an
  // ancestor's incidental font-weight (e.g. shadcn's Label, which defaults to font-medium).
  // eslint-disable-next-line react/no-danger
  return <div className="rte-content font-normal" dangerouslySetInnerHTML={{ __html: html }} />;
}
