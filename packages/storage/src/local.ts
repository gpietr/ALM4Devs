import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize, resolve, sep } from "node:path";
import type { StorageDriver } from "./index";

export interface LocalFsStorageOptions {
  root: string;
  signingSecret: string;
  /** Base path the signed URL is mounted at, e.g. "/api/storage/file" */
  servePath: string;
}

/**
 * What a verified token says about the object it points at. `contentType` is part of the
 * signed payload rather than something the serving route infers, so the bytes are always
 * served as the type they were registered as at upload time - and a caller can't change
 * how a file is interpreted by editing the URL.
 */
export interface SignedObject {
  key: string;
  contentType: string | null;
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/**
 * Local-filesystem storage driver: the self-host default. Files live under `root`
 * (a mounted Docker volume in production). "Signed URLs" are a small HMAC-signed,
 * expiring token embedding the object key - verified by a route handler
 * (`verifySignedToken`) that streams the file back, no object-storage service involved.
 */
export class LocalFsStorageDriver implements StorageDriver {
  constructor(private readonly opts: LocalFsStorageOptions) {}

  private resolvePath(key: string): string {
    const root = resolve(this.opts.root);
    const full = resolve(root, normalize(key).replace(/^(\.\.(\/|\\|$))+/, ""));
    if (full !== root && !full.startsWith(root + sep)) {
      throw new Error(`refusing to resolve storage key outside root: ${key}`);
    }
    return full;
  }

  async putObject(key: string, data: Uint8Array | ArrayBuffer): Promise<void> {
    const path = this.resolvePath(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data instanceof ArrayBuffer ? new Uint8Array(data) : data);
  }

  async getSignedUrl(key: string, opts?: { expiresInSeconds?: number; contentType?: string | null }): Promise<string> {
    const expiresAt = Date.now() + (opts?.expiresInSeconds ?? 300) * 1000;
    // JSON inside the signed blob rather than the old `key:expiry` string: the payload now
    // carries a third field, and content types contain colons and slashes of their own,
    // which positional splitting on ":" can't survive.
    const payload = JSON.stringify({ k: key, e: expiresAt, t: opts?.contentType ?? null });
    const encoded = Buffer.from(payload).toString("base64url");
    const token = `${encoded}.${sign(encoded, this.opts.signingSecret)}`;
    return `${this.opts.servePath}/${token}`;
  }

  async deleteObject(key: string): Promise<void> {
    await rm(this.resolvePath(key), { force: true });
  }

  /** Only for the walking-skeleton verification script - reads the file directly. */
  resolveForVerification(key: string): string {
    return this.resolvePath(key);
  }
}

/** Verifies a token minted by `getSignedUrl`, returning the signed object if valid. */
export function verifySignedToken(token: string, signingSecret: string): SignedObject {
  const dot = token.lastIndexOf(".");
  if (dot < 1) throw new Error("malformed token");
  const encoded = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  // Signature first, always: everything below trusts the payload, so nothing may parse it
  // before we know it's ours.
  const expected = sign(encoded, signingSecret);
  const sigBuf = Buffer.from(signature, "hex");
  const expBuf = Buffer.from(expected, "hex");
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    throw new Error("invalid signature");
  }

  let parsed: { k?: unknown; e?: unknown; t?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("malformed token");
  }
  if (typeof parsed.k !== "string" || !parsed.k || typeof parsed.e !== "number") {
    throw new Error("malformed token");
  }
  if (parsed.e < Date.now()) throw new Error("expired token");
  return { key: parsed.k, contentType: typeof parsed.t === "string" ? parsed.t : null };
}
