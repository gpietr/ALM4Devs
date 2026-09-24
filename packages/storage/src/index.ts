/**
 * Storage abstraction (TECH_STACK.md section 4): a small interface with two
 * implementations. `local` is the self-host default (evidence files on a mounted Docker
 * volume, no object-storage service required). `s3` (backlog item 3+, not needed for the
 * walking skeleton) will wrap Bun.S3Client for hosted SaaS / self-hosters who point at
 * their own bucket.
 */
export interface StorageDriver {
  putObject(key: string, data: Uint8Array | ArrayBuffer, contentType?: string): Promise<void>;
  getSignedUrl(key: string, opts?: { expiresInSeconds?: number; contentType?: string | null }): Promise<string>;
  deleteObject(key: string): Promise<void>;
}

export { LocalFsStorageDriver } from "./local";
export { verifySignedToken } from "./local";
export type { SignedObject } from "./local";
