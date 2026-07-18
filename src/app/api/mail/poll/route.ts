import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { getAllConnectedAccounts } from "@/lib/mail/store";
import { pollMailbox, type PollSummary } from "@/lib/mail/loop";
import { runWithCompany } from "@/lib/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Mailbox poll cron. A scheduler (Vercel cron / any timer) hits this on an
// interval; it fans out over every connected mailbox across all tenants and runs
// the scan loop. Inert until a mailbox is actually connected.
//
// Fail closed, exactly like /api/inbound: if MAIL_POLL_SECRET is unset the
// endpoint refuses to run rather than expose an unauthenticated, paid loop.
export async function POST(req: Request) {
  return run(req);
}

// Vercel cron issues GET; accept both.
export async function GET(req: Request) {
  return run(req);
}

async function run(req: Request) {
  const secret = config.mailPollSecret();
  if (!secret) {
    return NextResponse.json(
      { error: "Mail poll is disabled. Set MAIL_POLL_SECRET to enable it." },
      { status: 403 },
    );
  }
  const url = new URL(req.url);
  const provided =
    url.searchParams.get("secret") ||
    req.headers.get("x-webhook-secret") ||
    // Vercel cron sends: Authorization: Bearer <CRON_SECRET>. Accept it too.
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (provided !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const accounts = await getAllConnectedAccounts();
  const summaries: PollSummary[] = [];
  for (const account of accounts) {
    // Re-enter the account's tenant before any company-scoped read/write.
    const summary = await runWithCompany(account.companyId, () => pollMailbox(account));
    summaries.push(summary);
  }

  return NextResponse.json({
    ok: true,
    accounts: accounts.length,
    summaries,
  });
}
