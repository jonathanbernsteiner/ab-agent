import { NextResponse } from "next/server";
import { after } from "next/server";
import { cookies } from "next/headers";
import { getSession } from "@/lib/auth/guard";
import { runWithCompany } from "@/lib/tenant";
import {
  exchangeGoogleCode,
  externalOrigin,
  getGmailProfile,
  oauthRedirectUri,
} from "@/lib/mail/google";
import { upsertConnectedAccount } from "@/lib/mail/store";
import { pollAllForCompany } from "@/lib/mail/loop";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The response itself is a quick redirect, but after() runs the first mailbox
// scan (7-day backfill incl. extraction) inside this invocation's budget.
export const maxDuration = 300;

// Step 2 of the Gmail connect flow: Google redirects back here with ?code. We
// verify the state nonce, swap the code for tokens, resolve the mailbox address,
// store the connection, and kick off the initial scan after responding.
export async function GET(req: Request) {
  const origin = externalOrigin(req);
  const url = new URL(req.url);
  const back = (q: string) => {
    const res = NextResponse.redirect(`${origin}/settings?${q}`);
    res.cookies.delete("gmail_oauth_state");
    return res;
  };

  const session = await getSession();
  if (!session) return NextResponse.redirect(`${origin}/login`);
  if (session.profile.role !== "owner") return back("mail=error&reason=owner_only");

  if (url.searchParams.get("error")) return back("mail=error&reason=denied");

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expected = (await cookies()).get("gmail_oauth_state")?.value;
  if (!code || !state || !expected || state !== expected) {
    return back("mail=error&reason=state");
  }

  try {
    const tokens = await exchangeGoogleCode(code, oauthRedirectUri(req));
    const profile = await getGmailProfile(tokens.accessToken);

    await runWithCompany(session.company.id, () =>
      upsertConnectedAccount({
        provider: "gmail",
        externalEmail: profile.emailAddress,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        tokenExpiresAt: tokens.expiresAt,
        // null cursor → the first poll backfills the last 7 days, so recent ABs
        // show up right after connecting instead of only mail from now on.
        cursor: null,
      }),
    );

    // Initial scan now rather than on the next 10-minute cron tick.
    after(() =>
      runWithCompany(session.company.id, () => pollAllForCompany()).catch((err) =>
        console.error("[gmail connect] initial poll failed", err),
      ),
    );

    return back("mail=connected");
  } catch (err) {
    console.error("[gmail connect] callback failed", err);
    return back("mail=error&reason=exchange");
  }
}
