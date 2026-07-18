import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/guard";
import { runWithCompany } from "@/lib/tenant";
import { disconnectAccount } from "@/lib/mail/store";
import { revokeGoogleToken } from "@/lib/mail/google";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Disconnect a mailbox: revoke the Google grant (best effort) and drop the
// stored tokens. Owner-only, same as connecting.
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.profile.role !== "owner") {
    return NextResponse.json({ error: "Only the owner can disconnect a mailbox." }, { status: 403 });
  }

  let body: { accountId?: string };
  try {
    body = (await req.json()) as { accountId?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  if (!body.accountId) {
    return NextResponse.json({ error: "accountId required." }, { status: 400 });
  }

  return runWithCompany(session.company.id, async () => {
    const account = await disconnectAccount(body.accountId!);
    if (!account) {
      return NextResponse.json({ error: "Unknown mailbox account." }, { status: 404 });
    }
    // Revoking either token kills the whole grant; failures (already revoked,
    // network) don't matter — the local tokens are gone regardless.
    const token = account.refreshToken ?? account.accessToken;
    if (account.provider === "gmail" && token) await revokeGoogleToken(token);
    return NextResponse.json({ ok: true });
  });
}
