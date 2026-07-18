import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/guard";
import { runWithCompany } from "@/lib/tenant";
import { pollAllForCompany } from "@/lib/mail/loop";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Manual "sync now" from Settings → Integrations. Runs the same scan loop as
// the poll cron, but scoped to the caller's company and gated by the session
// instead of MAIL_POLL_SECRET.
export async function POST() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const summaries = await runWithCompany(session.company.id, () => pollAllForCompany());
  return NextResponse.json({ ok: true, summaries });
}
