import { auth } from "@/lib/auth";
import { clientIp } from "@/server/rate-limit";
import { toNextJsHandler } from "better-auth/next-js";

// The public sign-up and update-user paths are disabled in apps/web/src/lib/auth.ts via
// better-auth's own `disabledPaths`, rather than by pattern-matching the pathname here:
// that check runs inside better-auth's router, after its own path normalization, so it
// can't be sidestepped by whatever spelling of the path reaches this handler. Our two
// legitimate sign-up callers (/api/register, /api/accept-invite) go through auth.api.*
// in-process, which never touches the router and so is unaffected.
const handler = toNextJsHandler(auth);

/** better-auth keys its rate limiter off a client-IP header (auth.ts points it at
 * `x-galm-client-ip`). Whatever the caller sent under that name is discarded and replaced
 * with the address resolved by our own trusted-proxy logic, so it can't be spoofed to
 * dodge the sign-in limit - see clientIp() in server/rate-limit.ts. */
async function withResolvedIp(req: Request): Promise<Request> {
  const headers = new Headers(req.headers);
  headers.set("x-galm-client-ip", clientIp(req) ?? "unknown");
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(req.url, {
    method: req.method,
    headers,
    body: hasBody ? await req.arrayBuffer() : undefined,
  });
}

export const GET = async (req: Request) => handler.GET(await withResolvedIp(req));
export const POST = async (req: Request) => handler.POST(await withResolvedIp(req));
