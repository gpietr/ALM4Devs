import { DomainError } from "./errors";

/**
 * Validation for URLs the *server* will later fetch on a tenant's behalf - currently the
 * Spira base URL and the OpenAI-compatible LLM base URL, both of which are stored per
 * tenant and then called with that tenant's stored API key attached.
 *
 * Without this, saving a connection was a server-side request forgery primitive: anything
 * `new URL()` accepts was accepted, so a base URL of `http://169.254.169.254/` (cloud
 * instance metadata), `http://postgres:5432/` (a neighbouring container) or
 * `file:///etc/passwd` all passed `z.string().url()` happily, and the resulting fetch ran
 * from inside the trust boundary with credentials attached.
 *
 * Two separate rules, because they carry very different risk:
 *
 * - The scheme must be http/https. Never legitimate otherwise, so always enforced.
 * - The host must not be private/loopback/link-local. This one is opt-out, via
 *   ALLOW_PRIVATE_INTEGRATION_HOSTS=true, because this is a self-hosted product whose
 *   customers plausibly run their *own* Spira on their own network - "https://spira" on
 *   an internal VLAN is a normal, correct configuration for them, not an attack. Secure
 *   by default, with one documented switch, and an error that says which switch.
 *
 * What this does NOT do, deliberately, so nobody mistakes it for complete protection:
 * it checks the literal host in the URL, not what that host resolves to at fetch time. A
 * hostname whose DNS record points at 127.0.0.1 (or that re-resolves between this check
 * and the fetch - classic DNS rebinding) still gets through. Closing that properly needs
 * resolution-time enforcement - an egress proxy or an allowlist of reachable hosts - which
 * is an infrastructure decision, not something this function can make. This raises the
 * floor from "no check at all" to "no trivially internal target".
 */

/** Matches IPv4 literals in the ranges RFC1918/RFC5735 reserve for private or special use. */
const PRIVATE_IPV4 = [
  /^10\./,
  /^127\./,
  /^0\./,
  /^169\.254\./, // link-local, incl. the 169.254.169.254 cloud metadata endpoint
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // carrier-grade NAT
];

/** Hostnames that always mean "this machine" regardless of DNS. */
const LOCAL_HOSTNAMES = new Set(["localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback"]);

/**
 * The IPv4 address inside an IPv4-mapped IPv6 literal, in dotted-quad form, or null if
 * this isn't one. Accepts both spellings: `::ffff:127.0.0.1` as typed, and `::ffff:7f00:1`
 * as `new URL()` hands it back.
 */
function mappedIpv4(v6: string): string | null {
  const lower = v6.toLowerCase();
  if (!lower.startsWith("::ffff:")) return null;
  const rest = lower.slice(7);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(rest)) return rest;
  const hextets = rest.split(":");
  if (hextets.length !== 2 || !hextets.every((h) => /^[0-9a-f]{1,4}$/.test(h))) return null;
  const [hi, lo] = hextets.map((h) => Number.parseInt(h, 16)) as [number, number];
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (LOCAL_HOSTNAMES.has(host)) return true;
  // `.localhost`, `.local` and `.internal` are reserved/internal by convention.
  if (host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;

  // URL.hostname wraps IPv6 in brackets.
  if (host.startsWith("[") && host.endsWith("]")) {
    const v6 = host.slice(1, -1);
    if (v6 === "::1" || v6 === "::") return true;
    if (v6.startsWith("fe80:") || v6.startsWith("fc") || v6.startsWith("fd")) return true; // link-local / unique-local
    // ::ffff:127.0.0.1 and friends - an IPv4 address wearing an IPv6 hat. `new URL()`
    // re-serializes these into hex (::ffff:7f00:1), so matching the dotted-quad spelling
    // alone would miss every one that actually reaches us.
    const mapped = mappedIpv4(v6);
    if (mapped) return PRIVATE_IPV4.some((re) => re.test(mapped));
    return false;
  }

  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return PRIVATE_IPV4.some((re) => re.test(host));

  // A single-label hostname - `postgres`, `redis`, `spira` - has no public DNS answer; it
  // can only resolve through a container network, a search domain or /etc/hosts. So it
  // always names something inside the perimeter, which is the whole point of the check.
  if (!host.includes(".")) return true;

  return false;
}

/**
 * Throws a DomainError unless `value` is an http(s) URL pointing at an allowed host.
 * Returns the normalized URL string to store.
 */
export function assertSafeOutboundUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new DomainError(`${label} must be a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new DomainError(`${label} must start with http:// or https://.`);
  }
  if (isPrivateHost(url.hostname) && process.env.ALLOW_PRIVATE_INTEGRATION_HOSTS !== "true") {
    throw new DomainError(
      `${label} can't point at a private, loopback or link-local address. If this service really does run on your internal network, set ALLOW_PRIVATE_INTEGRATION_HOSTS=true on the server.`,
    );
  }
  return url.toString();
}

/**
 * The same normalization `assertSafeOutboundUrl` applies, but total: an unparseable value
 * comes back untouched. Used to compare a newly-submitted base URL against one already in
 * the database, which may predate this normalization (or may no longer pass validation at
 * all, e.g. an internal host saved before the check existed). Comparing normalized forms
 * keeps a cosmetic difference like a missing trailing slash from reading as "the operator
 * repointed this connection".
 */
export function normalizeOutboundUrl(value: string): string {
  try {
    return new URL(value.trim()).toString();
  } catch {
    return value.trim();
  }
}
