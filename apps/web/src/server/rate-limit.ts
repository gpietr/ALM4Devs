import { NextResponse } from "next/server";

/**
 * Fixed-window, in-memory rate limiter for the two registration endpoints that better-auth's
 * own limiter can't see.
 *
 * /api/register and /api/accept-invite are ordinary Next route handlers that call
 * `auth.api.signUpEmail(...)` in-process. better-auth's rate limiting lives in its HTTP
 * router (it caps /sign-up at 3 per 10s), and in-process calls never touch that router -
 * so both of our sign-up paths were completely unthrottled while the endpoint they wrap
 * was not.
 *
 * Deliberately the same shape as better-auth's own default limiter, including its limits:
 * a process-local Map, not Redis. That means per-instance counters (N replicas allow N×
 * the limit) and a reset on every deploy. It's a speed bump against scripted abuse, not a
 * distributed quota - if this ever fronts more than one instance, both this and
 * better-auth's `rateLimit.storage` want pointing at shared storage together.
 */
const buckets = new Map<string, { count: number; resetAt: number }>();

/** Bounds the Map against a spray of one-request-per-key probes. Cheap because expiry is
 * checked lazily on read anyway - this only stops idle entries accumulating forever. */
const MAX_TRACKED_KEYS = 10_000;

function sweep(now: number) {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

/**
 * The client IP, or null when it can't be determined. Reads the usual proxy headers, which
 * are trivially spoofable unless something in front of the app overwrites them - so this
 * is only meaningful behind a reverse proxy/ingress that does. (better-auth has the same
 * constraint and is explicit about it: without `advanced.ipAddress.ipAddressHeaders` set,
 * it logs a warning and falls back to one shared bucket for everyone.)
 */
function clientIp(req: Request): string | null {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip")?.trim() || null;
}

export interface RateLimitRule {
  /** Window length in seconds. */
  window: number;
  /** Requests allowed per window, per key. */
  max: number;
}

/**
 * A rule from `<PREFIX>_RATE_LIMIT_MAX` / `<PREFIX>_RATE_LIMIT_WINDOW`, falling back to
 * `fallback` when unset or unparseable - so the strict default is what a deployment gets
 * unless it deliberately opts out, rather than something a missing env var silently
 * disables (the failure mode REQUIRE_EMAIL_VERIFICATION already has).
 *
 * The local docker-compose stack raises these, because the e2e suite registers ~157
 * tenants from one IP in about eight seconds and would otherwise spend nine minutes
 * sitting out its own rate limit.
 */
export function ruleFromEnv(prefix: string, fallback: RateLimitRule): RateLimitRule {
  const read = (suffix: string, value: number) => {
    const raw = process.env[`${prefix}_RATE_LIMIT_${suffix}`];
    const parsed = raw === undefined ? Number.NaN : Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : value;
  };
  return { window: read("WINDOW", fallback.window), max: read("MAX", fallback.max) };
}

/**
 * Returns a 429 Response when `req` is over the limit for `name`, or null to proceed.
 *
 * Requests with no resolvable client IP share one bucket, keyed separately from the
 * per-IP ones, so a deployment that forwards no IP header still gets a global ceiling
 * rather than silently no limiting at all.
 */
export function rateLimit(req: Request, name: string, rule: RateLimitRule): Response | null {
  const now = Date.now();
  if (buckets.size > MAX_TRACKED_KEYS) sweep(now);

  const ip = clientIp(req);
  const key = `${name}:${ip ?? "no-ip"}`;
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + rule.window * 1000 });
    return null;
  }
  if (bucket.count >= rule.max) {
    const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
    return NextResponse.json(
      { error: "Too many requests. Please try again shortly." },
      { status: 429, headers: { "retry-after": String(retryAfter) } },
    );
  }
  bucket.count += 1;
  return null;
}
