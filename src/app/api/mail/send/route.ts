import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/guard";
import { runWithCompany } from "@/lib/tenant";
import { getAbReplyMeta, getSendingAccount } from "@/lib/mail/store";
import { sendViaGmail } from "@/lib/mail/send";
import { markChaserSent, recordDecision } from "@/lib/store";
import { learnContact } from "@/lib/contacts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Send a pushback/chaser email through the company's connected Gmail mailbox.
// The user edited the draft in the composer; this sends it verbatim. When abId
// is given and that AB arrived via the scanned mailbox, the mail threads onto
// the supplier's original email (threadId + In-Reply-To).
//
// After a successful send the flow advances by itself: the To: address is
// remembered as a supplier contact, a sent chaser snoozes the PO for the
// follow-up window (it resurfaces escalated if still unanswered), and a sent
// pushback is logged as a decision on the PO's timeline.
interface Body {
  to?: string;
  subject?: string;
  body?: string;
  abId?: string | null;
  kind?: "chaser" | "pushback";
  poNumber?: string | null;
  supplier?: string | null;
  level?: 1 | 2 | 3; // for chasers: which reminder level this draft was (3 = internal escalation)
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const to = body.to?.trim();
  const subject = body.subject?.trim();
  const text = body.body?.trim();
  if (!to || !subject || !text) {
    return NextResponse.json({ error: "to, subject and body are required." }, { status: 400 });
  }

  return runWithCompany(session.company.id, async () => {
    const account = await getSendingAccount();
    if (!account) {
      return NextResponse.json(
        { error: "No Gmail mailbox connected. Connect one in Settings → Integrations." },
        { status: 400 },
      );
    }

    const reply = body.abId ? await getAbReplyMeta(body.abId) : null;

    try {
      const result = await sendViaGmail(account, {
        to,
        subject,
        body: text,
        threadId: reply?.threadId ?? null,
        inReplyTo: reply?.rfcMessageId ?? null,
      });

      // A level-3 escalation is addressed to a colleague (owner/manager) —
      // never learn that address as the supplier's contact.
      const internal = body.kind === "chaser" && body.level === 3;
      if (body.supplier && !internal) {
        await learnContact({ supplier: body.supplier, email: to, source: "outbound" });
      }
      if (body.kind === "chaser" && body.poNumber) {
        await markChaserSent(body.poNumber, body.level === 3 ? 3 : body.level === 2 ? 2 : 1);
      } else if (body.kind === "pushback" && body.poNumber) {
        await recordDecision({
          poNumber: body.poNumber,
          position: null,
          abId: body.abId ?? null,
          kind: "pushback",
          payload: { to, subject },
        });
      }

      return NextResponse.json({ ok: true, id: result.id });
    } catch (err) {
      console.error("[mail send]", err);
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Send failed." },
        { status: 502 },
      );
    }
  });
}
