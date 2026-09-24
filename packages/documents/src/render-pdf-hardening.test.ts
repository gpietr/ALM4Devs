import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderPdf } from "./index";

/**
 * Pins the security-relevant flags renderPdf passes to wkhtmltopdf, without needing the
 * real binary or a network. Templates are user-authored HTML rendered inside our network,
 * so --disable-javascript (no script execution, hence no XHR-based SSRF/exfiltration) and
 * --disable-local-file-access (no /etc/passwd, no reading our own .env) are load-bearing.
 *
 * A stub binary, pointed at via WKHTMLTOPDF_BIN, records its argv one line per arg and
 * writes a minimal valid PDF so the happy path still succeeds. It writes to a fixed path
 * baked into the script rather than an env var, because renderPdf runs the binary under a
 * deliberately stripped-down environment (PATH/HOME/LANG only) that wouldn't carry one.
 */
describe("renderPdf hardening flags", () => {
  let dir: string;
  let argvFile: string;
  const prevBin = process.env.WKHTMLTOPDF_BIN;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wkhtml-stub-"));
    argvFile = join(dir, "argv.txt");
    const stub = join(dir, "wkhtmltopdf-stub");
    writeFileSync(
      stub,
      `#!/usr/bin/env bash
: > ${JSON.stringify(argvFile)}
for a in "$@"; do printf '%s\\n' "$a" >> ${JSON.stringify(argvFile)}; done
out="\${@: -1}"
printf '%%PDF-1.4\\n' > "$out"
`,
    );
    chmodSync(stub, 0o755);
    process.env.WKHTMLTOPDF_BIN = stub;
  });

  afterEach(() => {
    if (prevBin === undefined) delete process.env.WKHTMLTOPDF_BIN;
    else process.env.WKHTMLTOPDF_BIN = prevBin;
    rmSync(dir, { recursive: true, force: true });
  });

  const capturedArgv = () => readFileSync(argvFile, "utf8").split("\n").filter(Boolean);

  test("passes --disable-javascript and --disable-local-file-access", async () => {
    const pdf = await renderPdf("<h1>hello</h1>");
    expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe("%PDF-");

    const argv = capturedArgv();
    expect(argv).toContain("--disable-javascript");
    expect(argv).toContain("--disable-local-file-access");
  });

  test("the input and output paths come last, not swallowed by a flag", async () => {
    await renderPdf("<h1>hi</h1>");
    const argv = capturedArgv();
    const input = argv.at(-2) ?? "";
    const output = argv.at(-1) ?? "";
    // A misplaced comma in the argv array turns a flag into a filename or vice versa; the
    // last two entries must be the real positional in/out files.
    expect(input.endsWith(".html")).toBe(true);
    expect(output.endsWith(".pdf")).toBe(true);
    expect(input.startsWith("--")).toBe(false);
  });
});
