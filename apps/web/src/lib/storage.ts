import { LocalFsStorageDriver } from "@galm/storage";

/**
 * Walking-skeleton scope: local-filesystem driver only. The S3 driver (hosted SaaS) is
 * backlog item 3+, not needed to prove out the storage abstraction end-to-end here.
 */
export const storage = new LocalFsStorageDriver({
  root: process.env.STORAGE_LOCAL_ROOT ?? "/data/evidence",
  signingSecret: process.env.STORAGE_SIGNING_SECRET ?? "dev-only-insecure-secret",
  servePath: "/api/storage/file",
});
