import { NextResponse } from "next/server";
import { markChaserSent, upsertChaser } from "@/lib/store";
import { learnContact } from "@/lib/contacts";
import { addBusinessDays, todayIso } from "@/lib/dates";
import { sessionCompanyId } from "@/lib/auth/guard";
import { runWithCompany } from "@/lib/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Overdue chaser actions: snooze N days, mark resolved, bump to level 2, or
// mark sent (copy/mail-client path) — which snoozes for the follow-up window
// and escalates one step: an unanswered level-1 resurfaces as the firm level-2
// reminder, an unanswered level-2 as a level-3 internal escalation, and a sent
// escalation just re-snoozes (stays level 3) so it doesn't reappear next day.
interface Body {
  poNumber?: string;
  position?: number | null;
  action?: "snooze" | "resolve" | "escalate" | "sent";
  days?: number;
  until?: string; // custom snooze date (ISO yyyy-mm-dd)
  level?: 1 | 2 | 3; // for "sent": which reminder/escalation level went out
  to?: string; // for "sent": remember the address as a supplier contact
  supplier?: string | null;
}

export async function POST(req: Request) {
  const companyId = await sessionCompanyId();
  if (!companyId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return runWithCompany(companyId, async () => {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Ungültiges JSON." }, { status: 400 });
  }
  if (!body.poNumber || !body.action) {
    return NextResponse.json({ error: "poNumber und action erforderlich." }, { status: 400 });
  }

  try {
    if (body.action === "snooze") {
      const until =
        body.until && /^\d{4}-\d{2}-\d{2}$/.test(body.until)
          ? body.until
          : addBusinessDays(todayIso(), body.days ?? 2);
      await upsertChaser({
        poNumber: body.poNumber,
        position: body.position ?? null,
        status: "snoozed",
        snoozeUntil: until,
        action: body.until ? `snooze_until_${until}` : `snooze_${body.days ?? 2}d`,
      });
    } else if (body.action === "resolve") {
      await upsertChaser({
        poNumber: body.poNumber,
        position: body.position ?? null,
        status: "resolved",
        action: "marked_resolved",
      });
    } else if (body.action === "sent") {
      const level = body.level === 3 ? 3 : body.level === 2 ? 2 : 1;
      await markChaserSent(body.poNumber, level);
      // Level 3 goes to a colleague, not the supplier — don't learn that
      // address as a supplier contact.
      if (body.to && body.supplier && level < 3) {
        await learnContact({ supplier: body.supplier, email: body.to, source: "outbound" });
      }
    } else if (body.action === "escalate") {
      await upsertChaser({
        poNumber: body.poNumber,
        position: body.position ?? null,
        level: 2,
        status: "open",
        action: "escalated_level2",
      });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[chasers]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Fehler." },
      { status: 500 },
    );
  }
  });
}
