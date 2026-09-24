import Handlebars from "handlebars";
import JSZip from "jszip";

/**
 * Templated PDF document generation (backlog item 9.29): a tenant-defined HTML+CSS
 * template (with Handlebars placeholders) rendered against real entity data, then
 * converted to PDF - both steps are pure/stateless, nothing about a generated PDF is
 * ever stored. `packages/core/src/document-templates.ts` owns the template CRUD and the
 * per-scope data-gathering (`document-context.ts`); this package only knows how to turn
 * (html, context) into rendered HTML, and (html) into PDF bytes - kept separate from
 * `@galm/core` since neither of those two steps touches the database, and one of them
 * (PDF conversion) shells out to an external binary, a different kind of dependency than
 * anything else `@galm/core` needs.
 *
 * **PDF engine: wkhtmltopdf, not a headless browser.** Deliberately chosen over
 * Puppeteer/Playwright - a one-shot CLI conversion (pipe HTML in, get PDF bytes back) has
 * none of a browser automation session's failure modes (page-load races, zombie
 * processes, a multi-hundred-MB Chromium bundle in the Docker image). It's EOL upstream
 * (last released 2020) and its rendering engine is an older WebKit with real CSS gaps (no
 * Grid, limited Flexbox) - a real constraint for a general web page, but not for the
 * document-style templates this targets (headings/paragraphs/tables), which is exactly
 * the print-document use case it was built for and remains a de-facto standard for
 * (e.g. .NET's DinkToPdf is a wrapper around this same binary). Installed into the web
 * app's Docker image from the official `wkhtmltopdf/packaging` release build (not
 * Debian's own repo - dropped from recent releases) - see apps/web/Dockerfile.
 */

/** Compiles and renders a Handlebars template against a context object - a pure string
 * transform, no I/O. Split from `renderPdf` so a caller (or a future "preview as HTML"
 * feature) can render without needing the PDF binary at all. Handlebars' default escaping
 * is left on for every placeholder - `{{value}}` HTML-escapes, `{{{value}}}` doesn't -
 * exactly the same convention template authors already know from every other Handlebars
 * use, and correct here too: sanitized rich-text fields (descriptions, steps) are trusted
 * HTML and should use triple-stache, but a plain string field (a title, a parameter
 * value) should not - getting this right is the template author's job, the same as it
 * would be authoring any other Handlebars template. */
export function renderTemplate(html: string, context: unknown): string {
  const compiled = Handlebars.compile(html, { noEscape: false, strict: false });
  return compiled(context);
}

/** Renders a template's own filename format (backlog item 9.31 - "template should allow
 * to specify filename format") against the same context the body renders against, then
 * makes the result safe to actually save as a file. Unlike `renderTemplate`,
 * `noEscape: true` - a filename isn't HTML, so a literal `&` in a title has no business
 * coming out as `&amp;`. Falls back to `fallback` (the template's own `name`) if
 * `template` is empty/unset (an existing template predating this feature) or fails to
 * render for any reason (a typo'd placeholder shouldn't block generation entirely - a
 * less-ideal filename beats no file at all). The character-stripping matters more than
 * it used to now that a template can be applied to *many* files at once (a bulk/zip
 * export, one per selected test case or execution) - this is what turns
 * `{{displayId}} - {{title}}` into one safe, distinct name per file rather than
 * colliding on the template's own static name for every one of them. */
export function renderFilename(template: string | null | undefined, context: unknown, fallback: string): string {
  let rendered = "";
  if (template?.trim()) {
    try {
      const compiled = Handlebars.compile(template, { noEscape: true, strict: false });
      rendered = compiled(context).trim();
    } catch {
      rendered = "";
    }
  }
  const base = rendered || fallback;
  const sanitized = base
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 150);
  return sanitized || "document";
}

/** Wraps a template author's rendered HTML in a minimal document skeleton (doctype, utf-8
 * charset, a plain sans-serif base font) if it doesn't already look like a full document -
 * so a template can just be a body fragment (the common case: a heading, some paragraphs,
 * a table) without the author having to remember `<!DOCTYPE html>`/`<meta charset>`
 * boilerplate every time, while a template that already wrote its own `<html>` (a power
 * user wanting full control, e.g. a custom page size via `@page` CSS) is left untouched.
 * Exported (not just used internally by `renderPdf`) so the live template-editor preview
 * (backlog item 9.30) can apply the identical default styling an actual PDF would get,
 * without generating one - a preview that skipped this would look meaningfully plainer
 * than the real output for the common body-fragment-only template. */
export function ensureHtmlDocument(html: string): string {
  if (/<html[\s>]/i.test(html)) return html;
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { font-family: Helvetica, Arial, sans-serif; font-size: 12px; color: #111; }
  table { border-collapse: collapse; width: 100%; }
  td, th { border: 1px solid #ccc; padding: 4px 8px; text-align: left; }
  h1, h2, h3 { margin-top: 1.2em; margin-bottom: 0.4em; }
</style>
</head>
<body>
${html}
</body>
</html>`;
}

export class PdfRenderError extends Error {}

/** Converts HTML to PDF bytes by shelling out to `wkhtmltopdf <in.html> <out.pdf>` against
 * two temp files, not stdin/stdout pipes - confirmed for real, the hard way, that pipes
 * are the less reliable of the two for this binary: identical input piped through stdin
 * (`wkhtmltopdf - -`) failed under Bun's subprocess piping specifically
 * ("QPainter::begin(): Returned false") while the exact same conversion succeeded
 * immediately once file-based I/O replaced it - and file-based invocation is also the
 * long-established, most battle-tested way production wkhtmltopdf wrappers in every
 * other ecosystem (PHP's snappy, most Node wrappers, .NET's DinkToPdf) already do this,
 * not a novel choice made just to work around one local reproduction. A single process
 * per call either way - no pooling/reuse, no persistent browser session to manage or
 * leak, which was the whole reason wkhtmltopdf was chosen over a headless browser in the
 * first place. `WKHTMLTOPDF_BIN` overrides the binary name/path (defaults to
 * `wkhtmltopdf`, expected on `PATH` - see the Docker image), useful for local dev on a
 * machine that doesn't have it installed system-wide. */
export async function renderPdf(html: string): Promise<Uint8Array> {
  const bin = process.env.WKHTMLTOPDF_BIN ?? "wkhtmltopdf";
  const fullHtml = ensureHtmlDocument(html);

  // A minimal, explicit allow-list environment, not `{...process.env}` - this process's
  // own environment (DATABASE_URL and friends) has no business reaching an external
  // binary fed arbitrary template-rendered HTML, and on a machine with a real desktop
  // session (DISPLAY/WAYLAND_DISPLAY/QT_* all inherited, as any developer's own machine
  // typically has), wkhtmltopdf's "patched Qt" tries to use that real display and fails -
  // invisible on a clean Docker image (nothing display-related to inherit there to begin
  // with), but real anywhere else.
  const env: Record<string, string> = { PATH: process.env.PATH ?? "" };
  if (process.env.HOME) env.HOME = process.env.HOME;
  if (process.env.LANG) env.LANG = process.env.LANG;
  if (process.env.LC_ALL) env.LC_ALL = process.env.LC_ALL;
  if (process.env.LD_LIBRARY_PATH) env.LD_LIBRARY_PATH = process.env.LD_LIBRARY_PATH;

  const tmpDir = process.env.TMPDIR ?? "/tmp";
  const id = crypto.randomUUID();
  const inputPath = `${tmpDir}/galm-doc-${id}.html`;
  const outputPath = `${tmpDir}/galm-doc-${id}.pdf`;

  try {
    await Bun.write(inputPath, fullHtml);

    // A named helper, not `Bun.spawn(...)` inlined into a pre-typed `let` -
    // `ReturnType<typeof Bun.spawn>` on its own widens stdout/stderr back to their most
    // general possible type (losing the "pipe" literal narrowing TS infers from a direct
    // call with literal options), which `new Response(proc.stderr)` below needs.
    function startProcess() {
      return Bun.spawn(
        [
          bin,
          "--quiet",
          "--print-media-type",
          "--encoding",
          "utf-8",
          // --- Hardening ------------------------------------------------------------
          // Templates are user-authored HTML (Handlebars). wkhtmltopdf renders them
          // inside our network, so a template is an SSRF/exfiltration primitive unless
          // these are set. Authoring is intentionally NOT restricted - the engine is.
          //
          // Disables <script> execution. This is the one that turned a template into a
          // live SSRF tool: JS could XHR an internal endpoint (cloud metadata, a
          // neighbouring service) synchronously and document.write() the response body
          // straight into the PDF. Document templates (headings, tables, styling) never
          // need scripting, so nothing legitimate is lost.
          "--disable-javascript",
          // Belt to the engine's own default: this wkhtmltopdf build already refuses
          // file:// (ProtocolUnknownError), but state it so a future binary swap can't
          // silently re-open local-file reads (/etc/passwd, our own .env). Safe here
          // because templates carry no local asset references - images are data: URIs
          // or remote URLs, and the input document itself is passed positionally, not
          // loaded via file://.
          "--disable-local-file-access",
          inputPath,
          outputPath,
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
          env,
        },
      );
    }
    let proc: ReturnType<typeof startProcess>;
    try {
      proc = startProcess();
    } catch (err) {
      throw new PdfRenderError(
        `could not start ${bin} - is wkhtmltopdf installed? (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

    const outputFile = Bun.file(outputPath);
    const outputExists = await outputFile.exists();
    // wkhtmltopdf exits non-zero on real failures, but also on recoverable warnings (a
    // missing image, a slow-loading remote font) that still produce a usable PDF - only
    // treat it as a hard failure when no output file was actually written, matching how
    // the binary itself is documented to behave (its own docs: "exit code != 0 doesn't
    // necessarily mean it failed").
    if (!outputExists) {
      throw new PdfRenderError(
        `wkhtmltopdf produced no output (exit code ${exitCode})${stderr ? `: ${stderr.trim()}` : ""}`,
      );
    }
    return new Uint8Array(await outputFile.arrayBuffer());
  } finally {
    await Promise.all([
      Bun.file(inputPath)
        .delete()
        .catch(() => {}),
      Bun.file(outputPath)
        .delete()
        .catch(() => {}),
    ]);
  }
}

/** Bundles several already-generated files into one zip (backlog item 9.31/9.32 - bulk
 * generation of one report per selected test case/execution, downloaded as one zip
 * rather than N separate files). `jszip` (pure JS, no native/system dependency) rather
 * than shelling out to a `zip` binary - unlike wkhtmltopdf, there's no rendering engine
 * involved in writing a well-defined container format, so a plain library is genuinely
 * simpler here, not a corner cut. Duplicate filenames (two targets whose filename
 * template happened to render the same text) are disambiguated by appending " (2)",
 * " (3)", etc. - never silently overwriting one entry with another inside the same zip. */
export async function zipFiles(entries: Array<{ filename: string; content: Uint8Array }>): Promise<Uint8Array> {
  const zip = new JSZip();
  const seen = new Map<string, number>();
  for (const entry of entries) {
    const count = seen.get(entry.filename) ?? 0;
    seen.set(entry.filename, count + 1);
    const name = count === 0 ? entry.filename : withSuffix(entry.filename, `(${count + 1})`);
    zip.file(name, entry.content);
  }
  return zip.generateAsync({ type: "uint8array" });
}

function withSuffix(filename: string, suffix: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return `${filename} ${suffix}`;
  return `${filename.slice(0, dot)} ${suffix}${filename.slice(dot)}`;
}
