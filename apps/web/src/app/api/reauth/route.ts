import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { issueReauthToken } from "@/lib/reauth";
import { schema } from "@galm/db";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

/**
 * Verifies the current user's password fresh (not just "is there a valid session") and
 * mints a short-lived, single-use re-auth token. Delegates the actual credential check to
 * better-auth's own sign-in rather than reimplementing password verification against
 * whatever internal hash format it uses - the extra session that creates is immediately
 * deleted since it only ever existed to check the password, not to replace the caller's
 * real session.
 */
export async function POST(req: Request) {
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as { password?: string } | null;
  if (!body?.password) {
    return NextResponse.json({ error: "password is required" }, { status: 400 });
  }

  let verifyResult: { token?: string | null } | undefined;
  try {
    verifyResult = await auth.api.signInEmail({
      body: { email: session.user.email, password: body.password },
      asResponse: false,
    });
  } catch {
    return NextResponse.json({ error: "incorrect password" }, { status: 401 });
  }

  if (verifyResult?.token) {
    await db.delete(schema.session).where(eq(schema.session.token, verifyResult.token));
  }

  const { token, expiresAt } = issueReauthToken(session.user.id);
  return NextResponse.json({ token, expiresAt });
}
