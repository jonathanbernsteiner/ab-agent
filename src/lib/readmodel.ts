import "server-only";
import { getSupabase } from "@/lib/supabase";
import { businessDaysBetween, todayIso } from "@/lib/dates";
import { getAcceptedKeys, getChasers, paginate } from "@/lib/store";
import { getCompanyId } from "@/lib/tenant";
import { getDeadlines } from "@/lib/settings";
import { buildChaser, buildEscalation, type Signature } from "@/lib/chaser";
import type { Finding, PositionResult } from "@/lib/types";

// ── Digest: auto-matched ABs (zero-click, appear only here) ─────────────────

export interface DigestItem {
  abId: string;
  poNumber: string;
  supplier: string | null;
  abNumber: string | null;
  receivedAt: string;
  confirmedDates: string[];
}

export async function getDigest(): Promise<DigestItem[]> {
  const sb = getSupabase();
  const data = await paginate<{
    ab_id: string;
    po_number: string | null;
    positions: unknown;
    created_at: string;
    abs: unknown;
  }>(() =>
    sb
      .from("matches")
      .select("ab_id, po_number, positions, created_at, abs(ab_number, supplier, received_at)")
      .eq("company_id", getCompanyId())
      .eq("overall_bucket", "match")
      .order("created_at", { ascending: false }),
  );

  const seen = new Set<string>();
  const items: DigestItem[] = [];
  for (const m of data) {
    if (!m.po_number || seen.has(m.po_number)) continue;
    seen.add(m.po_number);
    const positions = (m.positions as PositionResult[]) ?? [];
    const ab = firstRel(m.abs) as { ab_number?: string; supplier?: string; received_at?: string } | null;
    items.push({
      abId: m.ab_id as string,
      poNumber: m.po_number as string,
      supplier: ab?.supplier ?? null,
      abNumber: ab?.ab_number ?? null,
      receivedAt: ab?.received_at ?? (m.created_at as string),
      confirmedDates: positions
        .map((p) => p.confirmed_date)
        .filter((d): d is string => !!d),
    });
  }
  return items;
}

// ── Deviation cards ─────────────────────────────────────────────────────────

export interface DeviationCard {
  abId: string;
  poNumber: string;
  supplier: string | null;
  abNumber: string | null;
  receivedAt: string;
  storagePath: string | null;
  positions: PositionResult[]; // unresolved deviating positions
  findings: Finding[]; // flattened, for the pushback draft
}

export async function getDeviationCards(): Promise<DeviationCard[]> {
  const sb = getSupabase();
  const data = await paginate<{
    ab_id: string;
    po_number: string | null;
    positions: unknown;
    created_at: string;
    abs: unknown;
  }>(() =>
    sb
      .from("matches")
      .select(
        "ab_id, po_number, positions, created_at, abs(ab_number, supplier, received_at, storage_path)",
      )
      .eq("company_id", getCompanyId())
      .eq("overall_bucket", "deviation")
      .order("created_at", { ascending: false }),
  );

  const accepted = await getAcceptedKeys();
  const seen = new Set<string>();
  const cards: DeviationCard[] = [];

  for (const m of data) {
    if (!m.po_number || seen.has(m.po_number)) continue;
    seen.add(m.po_number); // latest AB per PO wins
    const positions = (m.positions as PositionResult[]) ?? [];
    const unresolved = positions.filter(
      (p) =>
        p.bucket === "deviation" &&
        !accepted.has(`${m.po_number}|${p.position}`) &&
        !accepted.has(`${m.po_number}|*`),
    );
    if (unresolved.length === 0) continue;

    const ab = firstRel(m.abs) as
      | { ab_number?: string; supplier?: string; received_at?: string; storage_path?: string }
      | null;
    cards.push({
      abId: m.ab_id as string,
      poNumber: m.po_number as string,
      supplier: ab?.supplier ?? null,
      abNumber: ab?.ab_number ?? null,
      receivedAt: ab?.received_at ?? (m.created_at as string),
      storagePath: ab?.storage_path ?? null,
      positions: unresolved,
      findings: unresolved.flatMap((p) => p.findings),
    });
  }
  return cards;
}

// ── Awaiting / Overdue ──────────────────────────────────────────────────────

export interface OverdueCard {
  poNumber: string;
  supplier: string | null;
  article: string | null;
  poDate: string | null;
  requestedDate: string | null;
  businessDaysWaiting: number;
  // 1 = friendly reminder, 2 = firm with deadline, 3 = internal escalation
  // (the draft goes to the PO owner / manager, not the supplier).
  level: 1 | 2 | 3;
  snoozed: boolean;
  snoozeUntil: string | null;
  chaser: { subject: string; body: string };
}

export interface AwaitingResult {
  overdue: OverdueCard[];
  pending: OverdueCard[]; // still within the silent window
}

interface OpenPoRow {
  po_number: string;
  position: number;
  supplier: string | null;
  article: string | null;
  po_date: string | null;
  requested_date: string | null;
}

export async function getAwaiting(signature?: Signature): Promise<AwaitingResult> {
  const sb = getSupabase();
  const today = todayIso();

  // Open PO lines only.
  const cid = getCompanyId();
  // These four reads are independent — run them concurrently instead of chaining
  // four sequential round-trips.
  const [openPos, matched, chasers, deadlines] = await Promise.all([
    paginate<OpenPoRow>(() =>
      sb
        .from("pos")
        .select("po_number, position, supplier, article, po_date, requested_date")
        .eq("company_id", cid)
        .eq("status", "awaiting")
        .order("po_date", { ascending: true }),
    ),
    paginate<{ po_number: string; overall_bucket: string }>(() =>
      sb.from("matches").select("po_number, overall_bucket").eq("company_id", cid),
    ),
    getChasers(),
    getDeadlines(),
  ]);

  // PO numbers that already have an AB match (matched or deviating) are not "awaiting".
  const hasAb = new Set(
    matched
      .filter((m) => m.overall_bucket !== "no_po")
      .map((m) => m.po_number as string),
  );

  const { overdue_days, level2_days, escalation_days } = deadlines;

  // One card per PO (earliest po_date line represents it).
  const byPo = new Map<string, OpenPoRow>();
  for (const line of openPos) {
    if (hasAb.has(line.po_number)) continue;
    if (!byPo.has(line.po_number)) byPo.set(line.po_number, line);
  }

  const overdue: OverdueCard[] = [];
  const pending: OverdueCard[] = [];

  for (const line of byPo.values()) {
    const chaser = chasers.get(`${line.po_number}|*`);
    if (chaser?.status === "resolved") continue;

    const snoozed =
      chaser?.status === "snoozed" &&
      chaser.snooze_until != null &&
      chaser.snooze_until >= today;

    const waiting = line.po_date ? businessDaysBetween(line.po_date, today) : 0;

    // Time-based escalation, but a human/persisted level can be higher (a sent
    // level-2 reminder bumps the stored level to 3). Level 3 = escalation:
    // reminder 1 unanswered, reminder 2 unanswered — the third round goes
    // internal after a further escalation_days of silence.
    const timeLevel: 1 | 2 | 3 =
      waiting > overdue_days + level2_days + escalation_days
        ? 3
        : waiting > overdue_days + level2_days
          ? 2
          : 1;
    const level = Math.min(3, Math.max(timeLevel, chaser?.level ?? 1)) as 1 | 2 | 3;

    const poFields = {
      po_number: line.po_number,
      supplier: line.supplier,
      article: line.article,
      requested_date: line.requested_date,
      po_date: line.po_date,
    };
    const draft =
      level === 3
        ? buildEscalation(poFields, waiting, signature)
        : buildChaser(poFields, level, signature);

    const card: OverdueCard = {
      poNumber: line.po_number,
      supplier: line.supplier,
      article: line.article,
      poDate: line.po_date,
      requestedDate: line.requested_date,
      businessDaysWaiting: waiting,
      level,
      snoozed,
      snoozeUntil: chaser?.snooze_until ?? null,
      chaser: { subject: draft.subject, body: draft.body },
    };

    const isOverdue = waiting > overdue_days && !snoozed;
    if (isOverdue) overdue.push(card);
    else pending.push(card);
  }

  overdue.sort((a, b) => b.businessDaysWaiting - a.businessDaysWaiting);
  return { overdue, pending };
}

// ── Overview counts ─────────────────────────────────────────────────────────

export interface Overview {
  matched: number;
  deviations: number;
  overdue: number;
  pending: number;
  exportReady: number;
}

export async function getOverview(): Promise<Overview> {
  const sb = getSupabase();
  const cid = getCompanyId();
  const [digest, deviations, awaiting, exportRows] = await Promise.all([
    getDigest(),
    getDeviationCards(),
    getAwaiting(),
    paginate<{ positions: unknown }>(() =>
      sb.from("matches").select("positions").eq("company_id", cid),
    ),
  ]);
  let exportReady = 0;
  for (const m of exportRows) {
    const positions = (m.positions as PositionResult[]) ?? [];
    exportReady += positions.filter((p) => p.bucket === "match" && p.confirmed_date).length;
  }

  return {
    matched: digest.length,
    deviations: deviations.length,
    overdue: awaiting.overdue.length,
    pending: awaiting.pending.length,
    exportReady,
  };
}

// ── Recent activity (company-wide "what happened / what you did") ───────────

export interface ActivityItem {
  at: string;
  kind: "received" | "decision" | "chaser" | "import" | "export";
  label: string;
}

export async function getRecentActivity(limit = 12): Promise<ActivityItem[]> {
  const sb = getSupabase();
  const cid = getCompanyId();
  const items: ActivityItem[] = [];

  const { data: abs } = await sb
    .from("abs")
    .select("supplier, po_number, source, doc_kind, received_at")
    .eq("company_id", cid)
    .order("received_at", { ascending: false })
    .limit(limit);
  for (const a of abs ?? []) {
    if (a.doc_kind !== "ab") continue;
    items.push({
      at: a.received_at as string,
      kind: "received",
      label: `Confirmation from ${a.supplier ?? "supplier"} for PO ${a.po_number ?? "?"} (${a.source === "email" ? "email" : "upload"})`,
    });
  }

  const { data: decs } = await sb
    .from("decisions")
    .select("kind, po_number, position, created_at")
    .eq("company_id", cid)
    .order("created_at", { ascending: false })
    .limit(limit);
  for (const d of decs ?? []) {
    const verb = d.kind === "accept" ? "Accepted" : d.kind === "escalate" ? "Escalated" : "Pushback sent";
    items.push({
      at: d.created_at as string,
      kind: "decision",
      label: `${verb} — PO ${d.po_number}${d.position != null ? ` item ${d.position}` : ""}`,
    });
  }

  const { data: imports } = await sb
    .from("import_runs")
    .select("filename, row_count, created_at")
    .eq("company_id", cid)
    .order("created_at", { ascending: false })
    .limit(5);
  for (const im of imports ?? []) {
    items.push({
      at: im.created_at as string,
      kind: "import",
      label: `Imported ${im.row_count} PO lines${im.filename ? ` (${im.filename})` : ""}`,
    });
  }

  const { data: exports } = await sb
    .from("export_runs")
    .select("row_count, created_at")
    .eq("company_id", cid)
    .order("created_at", { ascending: false })
    .limit(5);
  for (const ex of exports ?? []) {
    items.push({ at: ex.created_at as string, kind: "export", label: `Exported ${ex.row_count} confirmations to SAP` });
  }

  return items
    .filter((i) => i.at)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, limit);
}

// ── AB detail ("what the AI read") ──────────────────────────────────────────

export interface AbDetail {
  ab: {
    id: string;
    ab_number: string | null;
    supplier: string | null;
    po_number: string | null;
    source: string;
    source_meta: Record<string, unknown> | null;
    original_filename: string | null;
    received_at: string;
    doc_kind: string;
    storage_path: string | null;
  };
  transcript: string;
  rawOutput: unknown;
  match: {
    overall_bucket: string;
    positions: PositionResult[];
  } | null;
  signedUrl: string | null;
}

export async function getAbDetail(abId: string): Promise<AbDetail | null> {
  const sb = getSupabase();
  const cid = getCompanyId();
  const { data: ab } = await sb
    .from("abs")
    .select("*")
    .eq("company_id", cid)
    .eq("id", abId)
    .limit(1)
    .single();
  if (!ab) return null;

  const { data: ex } = await sb
    .from("extractions")
    .select("raw_output, read_text")
    .eq("ab_id", abId)
    .order("created_at", { ascending: false })
    .limit(1);
  const extraction = ex && ex.length ? ex[0] : null;

  const { data: m } = await sb
    .from("matches")
    .select("overall_bucket, positions")
    .eq("ab_id", abId)
    .limit(1);
  const match = m && m.length ? m[0] : null;

  const { signedDocumentUrl } = await import("@/lib/supabase");
  const signedUrl = ab.storage_path ? await signedDocumentUrl(ab.storage_path) : null;

  return {
    ab: {
      id: ab.id,
      ab_number: ab.ab_number,
      supplier: ab.supplier,
      po_number: ab.po_number,
      source: ab.source,
      source_meta: ab.source_meta,
      original_filename: ab.original_filename,
      received_at: ab.received_at,
      doc_kind: ab.doc_kind,
      storage_path: ab.storage_path,
    },
    transcript: extraction?.read_text ?? "",
    rawOutput: extraction?.raw_output ?? null,
    match: match
      ? { overall_bucket: match.overall_bucket, positions: (match.positions as PositionResult[]) ?? [] }
      : null,
    signedUrl,
  };
}

// Supabase embeds a to-one relation as either an object or a single-element array
// depending on inference; normalize to the first record.
function firstRel(rel: unknown): unknown {
  if (Array.isArray(rel)) return rel[0] ?? null;
  return rel ?? null;
}
