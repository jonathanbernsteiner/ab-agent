import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { getSession } from "@/lib/auth/guard";
import { buildGoogleAuthUrl, externalOrigin, oauthRedirectUri } from "@/lib/mail/google";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Step 1 of the Gmail connect flow: send the owner to Google's consent screen.
// A random state nonce goes into an httpOnly cookie and must round-trip through
// Google unchanged (CSRF guard, verified in the callback).
export async function GET(req: Request) {
  const origin = externalOrigin(req);

  const session = await getSession();
  if (!session) return NextResponse.redirect(`${origin}/login`);
  if (session.profile.role !== "owner") {
    return NextResponse.redirect(`${origin}/settings?mail=error&reason=owner_only`);
  }
  if (!config.google.isConfigured()) {
    return NextResponse.redirect(`${origin}/settings?mail=error&reason=not_configured`);
  }

  const state = crypto.randomUUID();
  const res = NextResponse.redirect(buildGoogleAuthUrl(oauthRedirectUri(req), state));
  res.cookies.set("gmail_oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    secure: origin.startsWith("https"),
    maxAge: 600,
    path: "/",
  });
  return res;
}
