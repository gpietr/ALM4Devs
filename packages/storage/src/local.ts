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

  async getSignedUrl(key: string, opts?: { expiresInSeconds?: number }): Promise<string> {
    const expiresAt = Date.now() + (opts?.expiresInSeconds ?? 300) * 1000;
    const payload = `${key}:${expiresAt}`;
    const signature = sign(payload, this.opts.signingSecret);
    const token = Buffer.from(`${payload}:${signature}`).toString("base64url");
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

/** Verifies a token minted by `getSignedUrl`, returning the object key if valid. */
export function verifySignedToken(token: string, signingSecret: string): string {
  const decoded = Buffer.from(token, "base64url").toString("utf8");
  const lastColon = decoded.lastIndexOf(":");
  const payload = decoded.slice(0, lastColon);
  const signature = decoded.slice(lastColon + 1);
  const expected = sign(payload, signingSecret);

  const sigBuf = Buffer.from(signature, "hex");
  const expBuf = Buffer.from(expected, "hex");
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    throw new Error("invalid signature");
  }

  const [key, expiresAtStr] = payload.split(":");
  if (!key || Number(expiresAtStr) < Date.now()) {
    throw new Error("expired or malformed token");
  }
  return key;
}
