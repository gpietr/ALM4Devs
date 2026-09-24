import { auth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";

// The public sign-up and update-user paths are disabled in apps/web/src/lib/auth.ts via
// better-auth's own `disabledPaths`, rather than by pattern-matching the pathname here:
// that check runs inside better-auth's router, after its own path normalization, so it
// can't be sidestepped by whatever spelling of the path reaches this handler. Our two
// legitimate sign-up callers (/api/register, /api/accept-invite) go through auth.api.*
// in-process, which never touches the router and so is unaffected.
export const { GET, POST } = toNextJsHandler(auth);
