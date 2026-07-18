import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/guard";
import { runWithCompany } from "@/lib/tenant";
import { getAwaiting, type OverdueCard } from "@/lib/readmodel";
import { getDefaultContact, supplierKey } from "@/lib/contacts";
import { buildMergedChaser } from "@/lib/chaser";
import { getSendingAccount } from "@/lib/mail/store";
import { sendViaGmail } from "@/lib/mail/send";
import { markChaserSent, upsertChaser } from "@/lib/store";
import { getDeadlines } from "@/lib/settings";
import { addBusinessDays, todayIso } from "@/lib/dates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Bulk chaser actions from the Inbox's multi-select: send every selected PO its
// level-appropriate reminder through the connected Gmail (each supplier's saved
// default contact as recipient), snooze/resolve the whole selection, or mark it
// escalated ("escalated": handled internally — sets level 3 and snoozes for the
// follow-up window so the PO doesn't resurface the next day).
//
// Sends are per PO, not per supplier — that mirrors the single-PO flow, keeps
// markChaserSent's snooze/escalation bookkeeping intact, and gives the supplier
// one referenceable mail per Bestellung. POs are skipped (and reported) rather
// than failing the batch: no saved contact, no longer overdue by the time the
// batch runs, or already at the escalation level (their draft is internal — it
// must not go to the supplier).
interface Body {
  poNumbers?: string[];
  action?: "send" | "snooze" | "resolve" | "escalated";
  days?: number; // snooze length in business days
  merge?: boolean; // send: one email per supplier listing all their POs
}

const MAX_BATCH = 200;

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const poNumbers = Array.from(new Set(body.poNumbers ?? [])).filter(Boolean);
  if (poNumbers.length === 0 || !body.action) {
    return NextResponse.json({ error: "poNumbers and action are required." }, { status: 400 });
  }
  if (poNumbers.length > MAX_BATCH) {
    return NextResponse.json({ error: `At most ${MAX_BATCH} POs per batch.` }, { status: 400 });
  }

  return runWithCompany(session.company.id, async () => {
    if (body.action === "snooze" || body.action === "resolve") {
      const until = addBusinessDays(todayIso(), body.days ?? 2);
      for (const poNumber of poNumbers) {
        await upsertChaser(
          body.action === "snooze"
            ? { poNumber, position: null, status: "snoozed", snoozeUntil: until, action: `bulk_snooze_${body.days ?? 2}d` }
            : { poNumber, position: null, status: "resolved", action: "bulk_marked_resolved" },
        );
      }
      return NextResponse.json({ ok: true, done: poNumbers.length });
    }

    if (body.action === "escalated") {
      const { escalation_days } = await getDeadlines();
      const until = addBusinessDays(todayIso(), Math.max(1, escalation_days));
      for (const poNumber of poNumbers) {
        await upsertChaser({
          poNumber,
          position: null,
          level: 3,
          status: "snoozed",
          snoozeUntil: until,
          action: "bulk_marked_escalated",
        });
      }
      return NextResponse.json({ ok: true, done: poNumbers.length });
    }

    // action === "send"
    const account = await getSendingAccount();
    if (!account) {
      return NextResponse.json(
        { error: "No Gmail mailbox connected. Connect one in Settings → Integrations." },
        { status: 400 },
      );
    }

    const signature = { name: session.profile.name, company: session.company.name };
    const awaiting = await getAwaiting(signature);
    const overdueByPo = new Map(awaiting.overdue.map((c) => [c.poNumber, c]));

    let sent = 0;
    let emails = 0;
    const noContact: string[] = [];
    const notDue: string[] = [];
    const escalate: string[] = [];
    const failed: string[] = [];

    const due: OverdueCard[] = [];
    for (const poNumber of poNumbers) {
      const card = overdueByPo.get(poNumber);
      // Level-3 cards carry the internal escalation draft — never supplier mail.
      if (!card) notDue.push(poNumber);
      else if (card.level >= 3) escalate.push(poNumber);
      else due.push(card);
    }

    // One send unit is either a single PO or (merge) a supplier with all its
    // selected POs folded into one email.
    const units: { supplier: string | null; cards: OverdueCard[] }[] = [];
    if (body.merge) {
      const bySupplier = new Map<string, OverdueCard[]>();
      for (const card of due) {
        const key = card.supplier ? supplierKey(card.supplier) : `|${card.poNumber}`;
        const list = bySupplier.get(key) ?? [];
        list.push(card);
        bySupplier.set(key, list);
      }
      for (const cards of bySupplier.values()) units.push({ supplier: cards[0].supplier, cards });
    } else {
      for (const card of due) units.push({ supplier: card.supplier, cards: [card] });
    }

    // Sequential on purpose: bounded batch size, and Gmail's per-user send
    // quota punishes a parallel burst harder than it rewards the speed.
    for (const unit of units) {
      const contact = await getDefaultContact(unit.supplier);
      if (!contact) {
        noContact.push(...unit.cards.map((c) => c.poNumber));
        continue;
      }
      // Merged groups reuse the prebuilt single-PO draft when they hold one PO.
      const level = unit.cards.some((c) => c.level === 2) ? 2 as const : 1 as const;
      const draft =
        unit.cards.length === 1
          ? unit.cards[0].chaser
          : buildMergedChaser(
              unit.supplier,
              unit.cards.map((c) => ({
                po_number: c.poNumber,
                article: c.article,
                requested_date: c.requestedDate,
                po_date: c.poDate,
              })),
              level,
              signature,
            );
      try {
        await sendViaGmail(account, {
          to: contact.email,
          subject: draft.subject,
          body: draft.body,
        });
        emails++;
        for (const card of unit.cards) {
          await markChaserSent(card.poNumber, unit.cards.length === 1 ? card.level : level);
          sent++;
        }
      } catch (err) {
        console.error("[chasers bulk]", unit.supplier, err);
        failed.push(...unit.cards.map((c) => c.poNumber));
      }
    }

    return NextResponse.json({ ok: true, sent, emails, noContact, notDue, escalate, failed });
  });
}
