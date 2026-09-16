import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // NOT using output: "standalone" - verified while building the walking skeleton that
  // `next start` (which is what actually works under `bun run start`, confirmed serving a
  // real request) explicitly does not support standalone output; Next recommends running
  // `.next/standalone/server.js` directly for that mode instead, which was not verified to
  // work under Bun here. Revisit in backlog item 9 (self-host packaging) if image size
  // becomes worth the added complexity - the Dockerfile ships node_modules for now.
};

export default nextConfig;
