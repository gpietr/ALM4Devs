import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { rateLimit, ruleFromEnv } from "@/server/rate-limit";
import { acceptInvitation, markInvitationAccepted } from "@galm/core";
import { schema, withTenant } from "@galm/db";
import { APIError } from "better-auth";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

const ACCEPT_INVITE_RATE_LIMIT = ruleFromEnv("ACCEPT_INVITE", { window: 10, max: 3 });

const bodySchema = z.object({
  token: z.string().min(1),
  tenantId: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  password: z.string().min(8).max(200),
});

export async function POST(req: Request) {
  // A 32-byte token isn't guessable at any rate, so this caps the sign-up work behind the
  // token, not guessing at the token itself - this route bypasses better-auth's own
  // /sign-up ceiling by calling signUpEmail in-process.
  const limited = rateLimit(req, "accept-invite", ACCEPT_INVITE_RATE_LIMIT);
  if (limited) return limited;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { token, tenantId, name, password } = parsed.data;

  let invitation: Awaited<ReturnType<typeof acceptInvitation>>;
  try {
    invitation = await withTenant(db, tenantId, (tx) => acceptInvitation(tx, tenantId, token));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "invalid invitation" }, { status: 400 });
  }

  try {
    const res = await auth.api.signUpEmail({
      body: { name, email: invitation.email, password, tenantId, role: invitation.role },
      asResponse: true,
    });
    // Accepting an emailed invite already proves mailbox control the same way clicking a
    // verification link would, so mark the new user verified immediately - avoids making
    // an invited user go through email verification a second time. (better-auth's own
    // sendOnSignUp still fires once regardless - see auth.ts's sendVerificationEmail hook -
    // so one harmless, ignorable "verify your email" email still arrives; not worth
    // suppressing given the complexity that would take.)
    const body = (await res.clone().json().catch(() => ({}))) as { user?: { id: string } };
    if (body.user?.id) {
      await db.update(schema.user).set({ emailVerified: true }).where(eq(schema.user.id, body.user.id));
      await withTenant(db, tenantId, (tx) => markInvitationAccepted(tx, tenantId, invitation.id));
    }
    return res;
  } catch (err) {
    if (err instanceof APIError) {
      return NextResponse.json({ error: err.body?.message ?? err.message }, { status: err.statusCode ?? 400 });
    }
    throw err;
  }
}
