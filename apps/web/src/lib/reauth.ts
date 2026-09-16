import { db } from "@/lib/db";
import { schema } from "@galm/db";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * E-signature re-authentication (TECH_STACK.md section 6): a distinct, short-lived
 * "signing assertion" separate from the normal session. `/api/reauth` mints one of these
 * after a fresh password check; the transition endpoint requires and consumes it before
 * writing an approval_event for a status change that needs e-signature.
 */
const REAUTH_TTL_SECONDS = 120;

function secret(): string {
  return process.env.BETTER_AUTH_SECRET ?? "dev-only-insecure-secret";
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("hex");
}

export function issueReauthToken(userId: string): { token: string; expiresAt: number } {
  const jti = crypto.randomUUID();
  const issuedAt = Date.now();
  const expiresAt = issuedAt + REAUTH_TTL_SECONDS * 1000;
  const payload = `${userId}:${jti}:${issuedAt}:${expiresAt}`;
  const token = Buffer.from(`${payload}:${sign(payload)}`).toString("base64url");
  return { token, expiresAt };
}

/**
 * Verifies signature, expiry, and user match, then atomically consumes the token (an
 * INSERT whose primary-key collision on replay makes single-use enforcement safe across
 * restarts and multiple app instances - no in-memory state). Returns the moment the
 * underlying password check actually happened, for the approval_event's `reauthAt`.
 */
export async function verifyAndConsumeReauthToken(token: string, expectedUserId: string): Promise<Date> {
  let decoded: string;
  try {
    decoded = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    throw new Error("malformed re-auth token");
  }
  const lastColon = decoded.lastIndexOf(":");
  const payload = decoded.slice(0, lastColon);
  const signature = decoded.slice(lastColon + 1);

  const expected = sign(payload);
  const sigBuf = Buffer.from(signature, "hex");
  const expBuf = Buffer.from(expected, "hex");
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    throw new Error("invalid re-auth token");
  }

  const [userId, jti, issuedAtStr, expiresAtStr] = payload.split(":");
  if (!userId || !jti || !issuedAtStr || !expiresAtStr) {
    throw new Error("malformed re-auth token");
  }
  if (userId !== expectedUserId) {
    throw new Error("re-auth token does not belong to this user");
  }
  if (Number(expiresAtStr) < Date.now()) {
    throw new Error("re-auth token expired - please re-enter your password");
  }

  try {
    await db.insert(schema.reauthTokenUses).values({ jti });
  } catch {
    throw new Error("re-auth token already used");
  }

  return new Date(Number(issuedAtStr));
}
