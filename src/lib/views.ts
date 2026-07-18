import "server-only";
import { getSupabase, signedDocumentUrl } from "@/lib/supabase";
import { getCompanyId } from "@/lib/tenant";
import { businessDaysBetween, todayIso, formatEn, isoDateOf } from "@/lib/dates";
import { getAcceptedKeys } from "@/lib/store";
import { getDefaultContact } from "@/lib/contacts";
import { getDeadlines } from "@/lib/settings";
import { getSendingAccount } from "@/lib/mail/store";
import { getAwaiting, getDigest } from "@/lib/readmodel";
import { findingLabelEn } from "@/lib/findings";
import type {
  EffectiveStatus,
  Finding,
  MatchStatus,
  PositionResult,
} from "@/lib/types";

export type InboxStatus = "match" | "deviation" | "overdue" | "no_po" | "done";
function daysSince(iso: string | null): number {
  if (!iso) return 0;
  const then = Date.parse(isoDateOf(iso) + "T00:00:00Z");
  const now = Date.parse(todayIso() + "T00:00:00Z");
  return Math.max(0, Math.round((now - then) / 86400000));
}


// ── Matching: PO-grain cards, two lenses (Inbox / All POs) ───────────────────
//
// One card per PO. The Inbox is the subset that needs a human, grouped by the
// ACTION to take (decide / chase / escalate / check); All POs is every card,
// filterable by status. An AB whose PO isn't in SAP yet is a normal card too
// (status `waiting_import`) — it only enters the Inbox (queue `check`) once it
// has been stuck longer than the overdue window, because until then the next
// import resolves it with no human step. `escalate` is the chase endgame: two
// reminders went unanswered, so the next step is internal (PO owner / manager),
// not a third supplier mail.

export type MatchTab = "inbox" | "orders";
export type MatchQueue = "decide" | "chase" | "escalate" | "check";
export type CardStatus = EffectiveStatus | "waiting_import";

export interface PoCard {
  poNumber: string;
  supplier: string | null;
  lineCount: number; // 0 for waiting_import cards (no spine lines yet)
  deviatingCount: number;
  status: CardStatus; // worst line status (by urgency)
  queue: MatchQueue | null; // null → All POs only, nothing to do
  keyFindings: string | null;
  requestedDate: string | null; // earliest requested among lines
  confirmedDate: string | null; // latest confirmed among lines
  ageDays: number;
  urgency: number;
  abId: string | null; // waiting_import cards open the AB drawer
  abNumber: string | null;
}

export interface MatchingData {
  cards: PoCard[];
  counts: { inbox: number; all: number };
  digestCount: number;
}

const STATUS_URGENCY: Record<CardStatus, number> = {
  overdue: 1000,
  to_review: 800,
  externally_changed: 700,
  waiting_import: 600,
  awaiting: 300,
  confirmed: 100,
  exported: 50,
  archived: 0,
};

interface LineInfo {
  status: EffectiveStatus;
  supplier: string | null;
  requestedDate: string | null;
  confirmedDate: string | null;
  findingsSummary: string | null;
  ageDays: number;
}

export async function getMatching(): Promise<MatchingData> {
  const sb = getSupabase();
  const cid = getCompanyId();

  const [posRes, awaiting, unmatchedRes, digest, deadlines] = await Promise.all([
    sb
      .from("pos")
      .select(
        "po_number, position, supplier, requested_date, confirmed_date, status, findings_summary, exported_at",
      )
      .eq("company_id", cid)
      .order("po_number", { ascending: true })
      .order("position", { ascending: true }),
    getAwaiting(),
    sb
      .from("abs")
      .select("id, po_number, supplier, ab_number, received_at, doc_kind, matched_at")
      .eq("company_id", cid)
      .eq("doc_kind", "ab")
      .order("received_at", { ascending: false }),
    getDigest(),
    getDeadlines(),
  ]);

  // PO numbers currently overdue (awaiting + past grace, not snoozed), their
  // wait in business days and reminder level — the read-time overlay that turns
  // `awaiting` into `overdue` without storing it. Level 3 routes the card to
  // the `escalate` queue instead of `chase`.
  const overdueWait = new Map<string, number>();
  const overdueLevel = new Map<string, 1 | 2 | 3>();
  for (const o of awaiting.overdue) {
    overdueWait.set(o.poNumber, o.businessDaysWaiting);
    overdueLevel.set(o.poNumber, o.level);
  }

  // Fold the line spine into per-PO buckets, deriving each line's effective
  // status (`overdue`, `exported`) at read time exactly as before.
  const byPo = new Map<string, LineInfo[]>();
  for (const line of posRes.data ?? []) {
    const stored = line.status as MatchStatus;
    const poNumber = line.po_number as string;

    let status: EffectiveStatus = stored;
    if (stored === "awaiting" && overdueWait.has(poNumber)) status = "overdue";
    else if (stored === "confirmed" && line.exported_at) status = "exported";

    const ageDays =
      status === "overdue"
        ? overdueWait.get(poNumber) ?? 0
        : daysSince((line.confirmed_date as string) ?? null);

    const list = byPo.get(poNumber) ?? [];
    list.push({
      status,
      supplier: line.supplier as string | null,
      requestedDate: line.requested_date as string | null,
      confirmedDate: line.confirmed_date as string | null,
      findingsSummary: (line.findings_summary as string | null) ?? null,
      ageDays,
    });
    byPo.set(poNumber, list);
  }

  const cards: PoCard[] = [];
  for (const [poNumber, lines] of byPo) {
    const worst = lines.reduce((a, b) =>
      STATUS_URGENCY[b.status] > STATUS_URGENCY[a.status] ? b : a,
    );
    const deviatingCount = lines.filter((l) => l.status === "to_review").length;

    // The action this PO needs, if any. A deviation to decide beats everything
    // (it blocks the export); silence means chasing — or escalating internally
    // once two reminders went unanswered; SAP drift means checking.
    const queue: MatchQueue | null =
      deviatingCount > 0
        ? "decide"
        : worst.status === "overdue"
          ? (overdueLevel.get(poNumber) ?? 1) >= 3
            ? "escalate"
            : "chase"
          : lines.some((l) => l.status === "externally_changed")
            ? "check"
            : null;

    const summary =
      queue === "escalate"
        ? "2 reminders unanswered — escalate internally"
        : worst.findingsSummary ?? statusLabel(worst.status);
    const keyFindings =
      deviatingCount > 0 && lines.length > 1
        ? `${deviatingCount} of ${lines.length} lines — ${summary}`
        : summary;

    const requested = lines.map((l) => l.requestedDate).filter(Boolean).sort();
    const confirmed = lines.map((l) => l.confirmedDate).filter(Boolean).sort();
    const ageDays = Math.max(...lines.map((l) => l.ageDays));

    cards.push({
      poNumber,
      supplier: worst.supplier ?? lines.find((l) => l.supplier)?.supplier ?? null,
      lineCount: lines.length,
      deviatingCount,
      status: worst.status,
      queue,
      keyFindings,
      requestedDate: (requested[0] as string) ?? null,
      confirmedDate: (confirmed[confirmed.length - 1] as string) ?? null,
      ageDays,
      urgency: STATUS_URGENCY[worst.status] + ageDays,
      abId: null,
      abNumber: null,
    });
  }

  // ABs whose PO isn't in SAP yet: normal cards with status `waiting_import`.
  // Fresh ones need nobody (auto-match on next import); one stuck past the
  // overdue window escalates into the Inbox as a `check`.
  const today = todayIso();
  for (const d of unmatchedRes.data ?? []) {
    if (d.matched_at) continue;
    const receivedIso = d.received_at ? isoDateOf(d.received_at as string) : today;
    const waitingDays = businessDaysBetween(receivedIso, today);
    const stuck = waitingDays > deadlines.overdue_days;
    cards.push({
      poNumber: (d.po_number as string | null) ?? "—",
      supplier: d.supplier as string | null,
      lineCount: 0,
      deviatingCount: 0,
      status: "waiting_import",
      queue: stuck ? "check" : null,
      keyFindings: stuck
        ? `Confirmation waiting ${waitingDays} business days — PO still not in SAP list`
        : "Confirmation arrived — PO not in SAP list yet, auto-matches on next import",
      requestedDate: null,
      confirmedDate: null,
      ageDays: waitingDays,
      urgency: STATUS_URGENCY.waiting_import + waitingDays,
      abId: d.id as string,
      abNumber: (d.ab_number as string | null) ?? null,
    });
  }

  cards.sort((a, b) => b.urgency - a.urgency);

  return {
    cards,
    counts: {
      inbox: cards.filter((c) => c.queue !== null).length,
      all: cards.length,
    },
    digestCount: digest.length,
  };
}

function statusLabel(s: EffectiveStatus): string {
  switch (s) {
    case "awaiting":
      return "Awaiting confirmation";
    case "overdue":
      return "No confirmation — overdue";
    case "to_review":
      return "Needs review";
    case "confirmed":
      return "Confirmed";
    case "exported":
      return "Exported to SAP";
    case "externally_changed":
      return "Changed in SAP";
    case "archived":
      return "Closed in SAP";
  }
}

// ── The shared Drawer ───────────────────────────────────────────────────────

export interface DrawerLineItem {
  position: number | null;
  article: string | null;
  orderedQty: number | null;
  extractedQty: number | null;
  unitPrice: number | null;
  extractedPrice: number | null;
  requestedDate: string | null;
  confirmedDate: string | null;
  bucket: "match" | "deviation";
  resolved: boolean;
  findings: { label: string; raw: Finding }[];
}

export interface TimelineEvent {
  at: string;
  kind: string;
  label: string;
}

export interface DrawerData {
  entryType: "ab" | "po";
  poNumber: string | null;
  abId: string | null;
  supplier: string | null;
  abNumber: string | null;
  status: InboxStatus;
  context: "deviation" | "overdue" | "match" | "no_po" | "po";
  receivedAt: string | null;
  source: string | null;
  lineItems: DrawerLineItem[];
  overdue: {
    level: 1 | 2 | 3; // 3 = internal escalation (draft goes to owner/manager)
    businessDaysWaiting: number;
    snoozed: boolean;
    snoozeUntil: string | null;
    chaser: { subject: string; body: string };
    // Business days a sent chaser hides the PO before it resurfaces escalated.
    followUpDays: number;
  } | null;
  originalUrl: string | null;
  extraction: unknown;
  timeline: TimelineEvent[];
  crossLink: { abId: string | null; poNumber: string | null };
  // Sender of the AB email if it came by email, else the supplier's saved
  // default contact — prefills the chaser/pushback To: field.
  supplierEmail: string | null;
  signature: { name: string | null; company: string | null };
  // True when a connected Gmail mailbox can send — the composer then offers a
  // real Send button next to copy/mailto.
  canSendEmail: boolean;
}

export async function getDrawer(
  entry: { type: "ab"; id: string } | { type: "po"; poNumber: string },
  signature: { name: string | null; company: string | null } = { name: null, company: null },
): Promise<DrawerData | null> {
  const sb = getSupabase();
  const cid = getCompanyId();

  let abId: string | null = null;
  let poNumber: string | null = null;

  if (entry.type === "ab") {
    abId = entry.id;
    const { data: ab } = await sb.from("abs").select("po_number").eq("company_id", cid).eq("id", abId).limit(1).single();
    if (!ab) return null;
    poNumber = (ab?.po_number as string) ?? null;
  } else {
    poNumber = entry.poNumber;
    // latest AB for this PO, if any
    const { data: abList } = await sb
      .from("abs")
      .select("id, received_at")
      .eq("company_id", cid)
      .eq("po_number", poNumber)
      .eq("doc_kind", "ab")
      .order("received_at", { ascending: false })
      .limit(1);
    abId = abList && abList.length ? (abList[0].id as string) : null;
  }

  // Fetch the accepted-decisions set, the AB bundle, the timeline and the PO
  // spine supplier all at once — none depends on the others once abId/poNumber
  // are known. The pos lookup covers overdue POs, which have no AB row to name
  // the supplier.
  const [accepted, abBundle, timeline, sendingAccount, posSupplierRes] = await Promise.all([
    getAcceptedKeys(),
    loadAbBundle(sb, cid, abId),
    poNumber ? buildTimeline(poNumber) : Promise.resolve([] as TimelineEvent[]),
    getSendingAccount(),
    poNumber
      ? sb.from("pos").select("supplier").eq("company_id", cid).eq("po_number", poNumber).limit(1)
      : Promise.resolve({ data: null }),
  ]);
  const { abRow, extraction, match, originalUrl } = abBundle;
  const posSupplier =
    ((posSupplierRes.data as { supplier?: string | null }[] | null)?.[0]?.supplier as
      | string
      | null
      | undefined) ?? null;
  const supplier = (abRow?.supplier as string | null) ?? posSupplier;

  // Who to email: the sender of the AB email if it came by email, else the
  // supplier's saved default contact (Settings → Contacts / auto-learned).
  const abSenderEmail =
    abRow?.source === "email"
      ? extractEmail((abRow?.source_meta as { from?: string } | null)?.from)
      : null;
  const supplierEmail = abSenderEmail ?? (await getDefaultContact(supplier))?.email ?? null;

  const lineItems: DrawerLineItem[] = (match?.positions ?? []).map((p) => {
    const resolved = p.bucket === "match" || accepted.has(`${poNumber}|${p.position}`) || accepted.has(`${poNumber}|*`);
    return {
      position: p.position,
      article: p.article,
      orderedQty: p.ordered_qty,
      extractedQty: p.extracted_qty,
      unitPrice: p.unit_price,
      extractedPrice: p.extracted_price,
      requestedDate: p.requested_date,
      confirmedDate: p.confirmed_date,
      bucket: p.bucket,
      resolved,
      findings: p.findings.map((f) => ({ label: findingLabelEn(f), raw: f })),
    };
  });

  // Overdue context (PO with no resolving AB).
  let overdue: DrawerData["overdue"] = null;
  let context: DrawerData["context"] = "po";
  if (match?.overall_bucket === "deviation" && lineItems.some((l) => !l.resolved)) context = "deviation";
  else if (match?.overall_bucket === "match") context = "match";
  else if (match?.overall_bucket === "no_po" || (abRow && abRow.doc_kind !== "ab")) context = "no_po";

  if (poNumber && !abId) {
    const [awaiting, deadlines] = await Promise.all([getAwaiting(signature), getDeadlines()]);
    const card = awaiting.overdue.find((o) => o.poNumber === poNumber);
    if (card) {
      context = "overdue";
      overdue = {
        level: card.level,
        businessDaysWaiting: card.businessDaysWaiting,
        snoozed: card.snoozed,
        snoozeUntil: card.snoozeUntil,
        chaser: card.chaser,
        followUpDays: Math.max(
          1,
          card.level === 1 ? deadlines.level2_days : deadlines.escalation_days,
        ),
      };
    }
  }

  const status: InboxStatus =
    context === "overdue"
      ? "overdue"
      : context === "deviation"
        ? "deviation"
        : context === "match"
          ? "done"
          : context === "no_po"
            ? "no_po"
            : "done";

  return {
    entryType: entry.type,
    poNumber,
    abId,
    supplier,
    abNumber: (abRow?.ab_number as string) ?? null,
    status,
    context,
    receivedAt: (abRow?.received_at as string) ?? null,
    source: (abRow?.source as string) ?? null,
    lineItems,
    overdue,
    originalUrl,
    extraction,
    timeline,
    crossLink: { abId, poNumber },
    supplierEmail,
    signature,
    canSendEmail: !!sendingAccount,
  };
}

function extractEmail(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.match(/[^\s<>@,;]+@[^\s<>@,;]+/);
  return m ? m[0] : null;
}

// The AB row + its latest extraction + match + a signed original-document URL.
// The three table reads run concurrently.
async function loadAbBundle(
  sb: ReturnType<typeof getSupabase>,
  cid: string,
  abId: string | null,
): Promise<{
  abRow: Record<string, unknown> | null;
  extraction: unknown;
  match: { overall_bucket: string; positions: PositionResult[] } | null;
  originalUrl: string | null;
}> {
  if (!abId) return { abRow: null, extraction: null, match: null, originalUrl: null };
  const [abRes, exRes, mRes] = await Promise.all([
    sb.from("abs").select("*").eq("company_id", cid).eq("id", abId).limit(1).single(),
    sb.from("extractions").select("raw_output").eq("ab_id", abId).order("created_at", { ascending: false }).limit(1),
    sb.from("matches").select("overall_bucket, positions").eq("ab_id", abId).limit(1),
  ]);
  const abRow = (abRes.data as Record<string, unknown>) ?? null;
  const extraction = exRes.data && exRes.data.length ? exRes.data[0].raw_output : null;
  const match =
    mRes.data && mRes.data.length
      ? { overall_bucket: mRes.data[0].overall_bucket as string, positions: (mRes.data[0].positions as PositionResult[]) ?? [] }
      : null;
  const originalUrl = abRow?.storage_path ? await signedDocumentUrl(abRow.storage_path as string) : null;
  return { abRow, extraction, match, originalUrl };
}

async function buildTimeline(poNumber: string): Promise<TimelineEvent[]> {
  const sb = getSupabase();
  const cid = getCompanyId();
  const events: TimelineEvent[] = [];

  // Wave 1: the four po-keyed reads are independent — run them together.
  const [abRes, decRes, chRes, posRes] = await Promise.all([
    sb.from("abs").select("id, source, received_at").eq("company_id", cid).eq("po_number", poNumber),
    sb.from("decisions").select("created_at, kind, position, confirmed_date").eq("company_id", cid).eq("po_number", poNumber),
    sb.from("chasers").select("history").eq("company_id", cid).eq("po_number", poNumber),
    sb.from("pos").select("confirmed_source, status, updated_at, archived_at, confirmed_date").eq("company_id", cid).eq("po_number", poNumber),
  ]);
  const abList = abRes.data;
  const abIds = (abList ?? []).map((a) => a.id as string);
  for (const a of abList ?? []) {
    events.push({
      at: a.received_at as string,
      kind: "received",
      label: `Confirmation received via ${a.source === "email" ? "email" : "upload"}`,
    });
  }

  // Wave 2: extraction + match events need the ab ids from wave 1.
  if (abIds.length) {
    const [exs, ms] = await Promise.all([
      sb.from("extractions").select("created_at, model").in("ab_id", abIds),
      sb.from("matches").select("created_at, overall_bucket").in("ab_id", abIds),
    ]);
    for (const e of exs.data ?? []) events.push({ at: e.created_at as string, kind: "extraction", label: `Read by ${e.model}` });
    for (const m of ms.data ?? []) events.push({ at: m.created_at as string, kind: "match", label: `Match result: ${m.overall_bucket}` });
  }

  for (const d of decRes.data ?? []) {
    const verb = d.kind === "accept" ? "Accepted" : d.kind === "escalate" ? "Escalated" : "Pushback sent to supplier";
    events.push({
      at: d.created_at as string,
      kind: "decision",
      label: `${verb}${d.position != null ? ` (item ${d.position})` : ""}`,
    });
  }

  for (const c of chRes.data ?? []) {
    for (const h of (c.history as { at: string; action: string }[]) ?? []) {
      events.push({ at: h.at, kind: "chaser", label: chaserLabel(h.action) });
    }
  }

  for (const p of posRes.data ?? []) {
    if (p.status === "confirmed" && p.confirmed_source === "sap") {
      events.push({ at: p.updated_at as string, kind: "import", label: `Confirmed via SAP import` });
    }
    if (p.status === "externally_changed") {
      events.push({ at: p.updated_at as string, kind: "import", label: `Externally changed in SAP` });
    }
    if (p.status === "archived" && p.archived_at) {
      events.push({ at: p.archived_at as string, kind: "import", label: `Closed in SAP (archived)` });
    }
  }

  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return events;
}

function chaserLabel(action: string): string {
  if (action === "sent_level_1") return "Reminder sent (level 1)";
  if (action === "sent_level_2") return "Reminder sent (level 2, with deadline)";
  if (action === "sent_level_3") return "Escalated internally (to owner/manager)";
  if (action.startsWith("bulk_snooze")) return "Snoozed (bulk)";
  if (action.startsWith("snooze")) return `Snoozed`;
  if (action === "marked_resolved" || action === "bulk_marked_resolved") return "Marked resolved";
  if (action === "bulk_marked_escalated") return "Escalated internally (bulk)";
  if (action === "escalated_level2") return "Escalated to level 2";
  if (action === "auto_resolved_ab_received") return "Auto-resolved (confirmation received)";
  return action;
}

export { formatEn };
