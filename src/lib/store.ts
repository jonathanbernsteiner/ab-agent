import "server-only";
import { getSupabase } from "@/lib/supabase";
import { getCompanyId } from "@/lib/tenant";
import { addBusinessDays, todayIso } from "@/lib/dates";
import { getDeadlines } from "@/lib/settings";
import { findingsSummaryEn } from "@/lib/findings";
import { matchAb } from "@/lib/matching";
import { extractionFromRaw } from "@/lib/extraction/extract";
import type {
  Finding,
  MatchResult,
  MatchStatus,
  PoLine,
  PositionResult,
} from "@/lib/types";
import type { ExportRow } from "@/lib/sap/export";

// PostgREST (Supabase) caps a single response at the project's max-rows (1000 by
// default). Business tables here are append-only and grow without bound, so an
// unbounded `.select()` would silently truncate — dropping export rows, missing
// accepted decisions, etc. Read every unbounded set through this pager, which
// walks `.range()` windows until a short page signals the end. Pass a factory so
// each page gets a fresh query builder.
const PAGE_SIZE = 1000;
export async function paginate<T>(
  makeQuery: () => PromiseLike<{ data: unknown; error: unknown }> & {
    range: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>;
  },
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await makeQuery().range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const batch = (data ?? []) as T[];
    out.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return out;
}

// ── SAP import: update FACTS, never DECISIONS ───────────────────────────────

export interface ImportSummary {
  importRunId: string;
  inserted: number;
  updated: number;
  archived: number;
  confirmedBySap: number;
  externallyChanged: number;
}

export async function runImport(
  rows: PoLine[],
  filename: string | null,
  mapping: unknown,
): Promise<ImportSummary> {
  const sb = getSupabase();
  const cid = getCompanyId();

  const { data: run, error: runErr } = await sb
    .from("import_runs")
    .insert({ filename, row_count: rows.length, mapping, company_id: cid })
    .select("id")
    .single();
  if (runErr) throw runErr;
  const importRunId = run.id as string;

  // Existing active lines, to diff for archival and to detect external changes.
  // Paginated: if this truncated, absent lines past the cap would never archive.
  const existing = await paginate<{
    id: string;
    po_number: string;
    position: number;
    status: string;
  }>(() =>
    sb
      .from("pos")
      .select("id, po_number, position, status")
      .eq("company_id", cid)
      .neq("status", "archived"),
  );
  const existingKeys = new Set(
    existing.map((r) => `${r.po_number}|${r.position}`),
  );

  const seen = new Set<string>();
  let inserted = 0;
  let updated = 0;
  let confirmedBySap = 0;
  let externallyChanged = 0;

  for (const row of rows) {
    const key = `${row.po_number}|${row.position}`;
    seen.add(key);
    const isNew = !existingKeys.has(key);

    // What the tool queued for this line (auto match or accepted decision).
    const queued = await getQueuedDate(row.po_number, row.position);

    let status = "awaiting";
    let confirmed_source: string | null = null;
    let confirmed_date: string | null = null;
    let external_confirmed_date: string | null = null;

    if (row.confirmed_date) {
      // SAP now shows a confirmed date for this line.
      if (queued && queued === row.confirmed_date) {
        status = "confirmed";
        confirmed_source = "sap";
        confirmed_date = row.confirmed_date;
        confirmedBySap++;
      } else if (queued && queued !== row.confirmed_date) {
        // SAP wins; log that it changed outside the tool.
        status = "externally_changed";
        confirmed_source = "sap";
        confirmed_date = row.confirmed_date;
        external_confirmed_date = row.confirmed_date;
        externallyChanged++;
      } else {
        status = "confirmed";
        confirmed_source = "sap";
        confirmed_date = row.confirmed_date;
        confirmedBySap++;
      }
    }

    const payload = {
      company_id: cid,
      po_number: row.po_number,
      position: row.position,
      article: row.article,
      article_desc: row.article_desc,
      ordered_qty: row.ordered_qty,
      unit_price: row.unit_price,
      currency: row.currency,
      requested_date: row.requested_date,
      po_date: row.po_date,
      supplier: row.supplier,
      confirmed_date,
      confirmed_source,
      external_confirmed_date,
      status,
      archived_at: null,
      last_import_run_id: importRunId,
      last_seen_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const { error } = await sb
      .from("pos")
      .upsert(payload, { onConflict: "company_id,po_number,position" });
    if (error) throw error;
    if (isNew) inserted++;
    else updated++;
  }

  // Lines that were active but are absent now → closed in SAP → archive.
  let archived = 0;
  for (const r of existing) {
    const key = `${r.po_number}|${r.position}`;
    if (!seen.has(key)) {
      await sb
        .from("pos")
        .update({ status: "archived", archived_at: new Date().toISOString() })
        .eq("id", r.id);
      archived++;
    }
  }

  // An order confirmation may have arrived before its PO was in SAP (unmatched
  // document queue). Now that these POs are imported, re-match those ABs — no
  // human step — then fold every AB/decision back onto the freshly-imported
  // lines so their spine status/confirmed fields reflect the confirmations.
  const importedPos = new Set(rows.map((r) => r.po_number));
  await rematchUnmatchedAbs(importedPos);
  await recomputeImportedPos(importedPos);

  return {
    importRunId,
    inserted,
    updated,
    archived,
    confirmedBySap,
    externallyChanged,
  };
}

// ── Materialized spine: the sole writer of a line's status + promoted fields ──

// Recompute every line of one PO from its facts, latest AB match, and accepted
// decisions, and write the result onto the pos rows. Called after each AB
// ingest, decision, and SAP import. Deterministic and idempotent.
export async function recomputePo(poNumber: string): Promise<void> {
  const sb = getSupabase();
  const cid = getCompanyId();
  const [linesRes, matches, decisions] = await Promise.all([
    sb.from("pos").select("*").eq("company_id", cid).eq("po_number", poNumber),
    paginate<MatchRow>(() =>
      sb
        .from("matches")
        .select("ab_id, positions, created_at")
        .eq("company_id", cid)
        .eq("po_number", poNumber)
        .order("created_at", { ascending: false }),
    ),
    paginate<AcceptRow>(() =>
      sb
        .from("decisions")
        .select("position, confirmed_date, confirmed_qty, confirmed_price, kind, created_at")
        .eq("company_id", cid)
        .eq("po_number", poNumber)
        .eq("kind", "accept")
        .order("created_at", { ascending: false }),
    ),
  ]);
  const lines = (linesRes.data as PoLine[]) ?? [];
  for (const line of lines) {
    const patch = computeLinePatch(line, matches, decisions);
    if (!patch) continue;
    await sb
      .from("pos")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("company_id", cid)
      .eq("id", line.id!);
  }
}

interface MatchRow {
  ab_id: string;
  positions: unknown;
  created_at: unknown;
}
interface AcceptRow {
  position: number | null;
  confirmed_date: string | null;
  confirmed_qty: number | null;
  confirmed_price: number | null;
  kind: string;
  created_at: unknown;
}

interface LinePatch {
  status: MatchStatus;
  confirmed_source: string | null;
  confirmed_date: string | null;
  confirmed_qty: number | null;
  confirmed_price: number | null;
  findings: Finding[];
  findings_summary: string | null;
  source_ab_id: string | null;
}

// Pure projection: (line facts, matches newest-first, accepted decisions) → the
// spine columns to write. SAP-owned states win over AB confirmations.
function computeLinePatch(
  line: PoLine,
  matches: MatchRow[],
  decisions: AcceptRow[],
): LinePatch | null {
  // Terminal / SAP-authoritative states are not re-derived from ABs ("SAP wins").
  if (line.status === "archived") return null;
  if (line.external_confirmed_date) return null; // externally_changed
  if (line.confirmed_source === "sap") return null; // SAP-confirmed the date

  // Newest AB position that refers to this line (by po_id, else by position no.).
  let matchPos: PositionResult | null = null;
  let sourceAbId: string | null = null;
  for (const m of matches) {
    const positions = (m.positions as PositionResult[]) ?? [];
    const p = positions.find(
      (x) =>
        (line.id != null && x.po_id === line.id) ||
        (x.position != null && x.position === line.position),
    );
    if (p) {
      matchPos = p;
      sourceAbId = m.ab_id;
      break;
    }
  }

  // Accepted decision override — a line-specific accept beats a PO-wide ('*').
  const dec =
    decisions.find((d) => d.position === line.position) ??
    decisions.find((d) => d.position == null) ??
    null;

  let status: MatchStatus = "awaiting";
  let confirmed_source: string | null = null;
  let confirmed_date: string | null = null;
  let confirmed_qty: number | null = null;
  let confirmed_price: number | null = null;
  let findings: Finding[] = [];

  if (!matchPos) {
    status = "awaiting";
  } else if (matchPos.bucket === "match") {
    status = "confirmed";
    confirmed_source = "auto";
    confirmed_date = matchPos.confirmed_date;
    confirmed_qty = matchPos.extracted_qty;
    confirmed_price = matchPos.extracted_price;
  } else if (dec) {
    // Deviation that a human accepted → confirmed with the queued values.
    status = "confirmed";
    confirmed_source = "approved";
    confirmed_date = dec.confirmed_date ?? matchPos.confirmed_date;
    confirmed_qty = dec.confirmed_qty ?? matchPos.extracted_qty;
    confirmed_price = dec.confirmed_price ?? matchPos.extracted_price;
  } else {
    // Deviation awaiting a human decision.
    status = "to_review";
    confirmed_date = matchPos.confirmed_date;
    confirmed_qty = matchPos.extracted_qty;
    confirmed_price = matchPos.extracted_price;
    findings = matchPos.findings ?? [];
  }

  return {
    status,
    confirmed_source,
    confirmed_date,
    confirmed_qty,
    confirmed_price,
    findings,
    findings_summary: findings.length ? findingsSummaryEn(findings) : null,
    source_ab_id: matchPos ? sourceAbId : null,
  };
}

// Recompute the PO lines touched by this import that carry a confirmation or a
// decision (the rest are plain 'awaiting', already written by the import loop).
async function recomputeImportedPos(importedPos: Set<string>): Promise<void> {
  const sb = getSupabase();
  const cid = getCompanyId();
  const [matchPoRows, decPoRows] = await Promise.all([
    paginate<{ po_number: string | null }>(() =>
      sb.from("matches").select("po_number").eq("company_id", cid),
    ),
    paginate<{ po_number: string | null }>(() =>
      sb.from("decisions").select("po_number").eq("company_id", cid),
    ),
  ]);
  const touched = new Set<string>();
  for (const r of matchPoRows) if (r.po_number) touched.add(r.po_number);
  for (const r of decPoRows) if (r.po_number) touched.add(r.po_number);
  for (const po of touched) {
    if (importedPos.has(po)) await recomputePo(po);
  }
}

// Re-run matching for every order confirmation still waiting for its PO, when
// that PO is among the ones just imported. Updates the AB's match row in place
// and stamps abs.matched_at so it leaves the unmatched queue.
async function rematchUnmatchedAbs(importedPos: Set<string>): Promise<void> {
  const sb = getSupabase();
  const cid = getCompanyId();
  const unmatched = await paginate<{ id: string; po_number: string | null; doc_kind: string; matched_at: string | null }>(
    () =>
      sb
        .from("abs")
        .select("id, po_number, doc_kind, matched_at")
        .eq("company_id", cid)
        .eq("doc_kind", "ab"),
  );
  for (const ab of unmatched) {
    if (ab.matched_at) continue;
    if (!ab.po_number || !importedPos.has(ab.po_number)) continue;

    const { data: exRows } = await sb
      .from("extractions")
      .select("raw_output")
      .eq("ab_id", ab.id)
      .order("created_at", { ascending: false })
      .limit(1);
    if (!exRows || !exRows.length) continue;
    const extraction = extractionFromRaw((exRows[0] as { raw_output: unknown }).raw_output);

    const poLines = await getActivePoLines(ab.po_number);
    const alreadyConfirmed = confirmedPositions(poLines);
    const match = matchAb(extraction, poLines, alreadyConfirmed);
    if (match.overall_bucket === "no_po") continue; // still no lines — leave queued

    await sb
      .from("matches")
      .update({
        po_number: match.po_number,
        overall_bucket: match.overall_bucket,
        positions: match.positions,
      })
      .eq("company_id", cid)
      .eq("ab_id", ab.id);
    await sb
      .from("abs")
      .update({ matched_at: new Date().toISOString() })
      .eq("company_id", cid)
      .eq("id", ab.id);
  }
}

// PO position numbers that already carry a (non-SAP) confirmation — a later AB
// for one of these is flagged `superseded` and re-enters review.
export function confirmedPositions(poLines: PoLine[]): Set<number> {
  const set = new Set<number>();
  for (const l of poLines) {
    if (l.status === "confirmed" && l.confirmed_source !== "sap" && l.position != null) {
      set.add(l.position);
    }
  }
  return set;
}

// The date the tool has committed for a PO line: an accepted deviation wins,
// else an auto-matched confirmed date.
export async function getQueuedDate(
  poNumber: string,
  position: number,
): Promise<string | null> {
  const sb = getSupabase();
  const cid = getCompanyId();
  const { data: dec } = await sb
    .from("decisions")
    .select("confirmed_date, created_at")
    .eq("company_id", cid)
    .eq("po_number", poNumber)
    .eq("position", position)
    .eq("kind", "accept")
    .order("created_at", { ascending: false })
    .limit(1);
  if (dec && dec.length && dec[0].confirmed_date) return dec[0].confirmed_date;

  const matches = await paginate<{ positions: unknown; created_at: unknown }>(() =>
    sb
      .from("matches")
      .select("positions, created_at")
      .eq("company_id", cid)
      .eq("po_number", poNumber)
      .order("created_at", { ascending: false }),
  );
  for (const m of matches) {
    const positions = (m.positions as MatchPositionRow[]) ?? [];
    const p = positions.find(
      (x) => x.position === position && x.bucket === "match" && x.confirmed_date,
    );
    if (p?.confirmed_date) return p.confirmed_date;
  }
  return null;
}

interface MatchPositionRow {
  position: number | null;
  bucket: "match" | "deviation";
  confirmed_date: string | null;
}

// ── PO lookup for matching ──────────────────────────────────────────────────

export async function getActivePoLines(poNumber: string): Promise<PoLine[]> {
  const sb = getSupabase();
  const { data } = await sb
    .from("pos")
    .select("*")
    .eq("company_id", getCompanyId())
    .eq("po_number", poNumber)
    .neq("status", "archived")
    .order("position", { ascending: true });
  return (data as PoLine[]) ?? [];
}

// ── AB persistence + dedupe ─────────────────────────────────────────────────

export interface AbRecord {
  id: string;
  po_number: string | null;
  supplier: string | null;
  ab_number: string | null;
  doc_kind: string;
}

export async function findAbByHash(hash: string): Promise<AbRecord | null> {
  const sb = getSupabase();
  const { data } = await sb
    .from("abs")
    .select("id, po_number, supplier, ab_number, doc_kind")
    .eq("company_id", getCompanyId())
    .eq("content_hash", hash)
    .limit(1);
  return data && data.length ? (data[0] as AbRecord) : null;
}

export interface PersistArgs {
  contentHash: string;
  source: "upload" | "email";
  sourceMeta?: Record<string, unknown>;
  storagePath?: string | null;
  originalFilename?: string | null;
  mimeType?: string | null;
  abNumber: string | null;
  supplier: string | null;
  poNumber: string | null;
  docKind: "ab" | "not_ab" | "unknown";
  model: string;
  rawOutput: unknown;
  transcript: string;
  match: MatchResult | null;
}

export async function persistAb(args: PersistArgs): Promise<string> {
  const sb = getSupabase();
  const cid = getCompanyId();

  // An AB that resolved to real PO lines is "matched"; a real order confirmation
  // whose PO isn't in SAP yet (no_po) stays in the unmatched queue (matched_at
  // null) until a later import brings its PO in.
  const matchedAt =
    args.docKind === "ab" && args.match && args.match.overall_bucket !== "no_po"
      ? new Date().toISOString()
      : null;

  const { data: ab, error: abErr } = await sb
    .from("abs")
    .insert({
      company_id: cid,
      ab_number: args.abNumber,
      supplier: args.supplier,
      po_number: args.poNumber,
      source: args.source,
      source_meta: args.sourceMeta ?? null,
      storage_path: args.storagePath ?? null,
      original_filename: args.originalFilename ?? null,
      mime_type: args.mimeType ?? null,
      content_hash: args.contentHash,
      doc_kind: args.docKind,
      matched_at: matchedAt,
    })
    .select("id")
    .single();
  if (abErr) throw abErr;
  const abId = ab.id as string;

  const { data: ex, error: exErr } = await sb
    .from("extractions")
    .insert({
      company_id: cid,
      ab_id: abId,
      model: args.model,
      raw_output: args.rawOutput,
      read_text: args.transcript,
    })
    .select("id")
    .single();
  if (exErr) throw exErr;

  if (args.match && args.docKind === "ab") {
    const { error: mErr } = await sb.from("matches").insert({
      company_id: cid,
      ab_id: abId,
      extraction_id: ex.id,
      po_number: args.match.po_number,
      overall_bucket: args.match.overall_bucket,
      positions: args.match.positions,
    });
    if (mErr) throw mErr;
  }

  return abId;
}

// ── Decisions & chasers (persist across imports, keyed to PO) ────────────────

export async function recordDecision(args: {
  poNumber: string;
  position: number | null;
  abId: string | null;
  kind: "accept" | "escalate" | "pushback";
  confirmedDate?: string | null;
  confirmedQty?: number | null;
  confirmedPrice?: number | null;
  payload?: Record<string, unknown>;
}): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb.from("decisions").insert({
    company_id: getCompanyId(),
    po_number: args.poNumber,
    position: args.position,
    ab_id: args.abId,
    kind: args.kind,
    confirmed_date: args.confirmedDate ?? null,
    confirmed_qty: args.confirmedQty ?? null,
    confirmed_price: args.confirmedPrice ?? null,
    payload: args.payload ?? null,
  });
  if (error) throw error;
  // Fold the decision onto the spine (an accepted deviation → confirmed).
  await recomputePo(args.poNumber);
}

// Accept every still-unresolved deviating position on one AB (bulk / "accept
// all"). Reads the stored match so the caller doesn't need the line values.
export async function acceptAllForAb(abId: string): Promise<number> {
  const sb = getSupabase();
  const { data } = await sb
    .from("matches")
    .select("po_number, positions")
    .eq("company_id", getCompanyId())
    .eq("ab_id", abId)
    .limit(1);
  if (!data || !data.length) return 0;
  const poNumber = data[0].po_number as string;
  const positions = (data[0].positions as PositionResult[]) ?? [];
  const accepted = await getAcceptedKeys();
  let n = 0;
  for (const p of positions) {
    if (p.bucket !== "deviation") continue;
    if (accepted.has(`${poNumber}|${p.position}`) || accepted.has(`${poNumber}|*`)) continue;
    await recordDecision({
      poNumber,
      position: p.position,
      abId,
      kind: "accept",
      confirmedDate: p.confirmed_date,
      confirmedQty: p.extracted_qty,
      confirmedPrice: p.extracted_price,
    });
    n++;
  }
  return n;
}

export async function getAcceptedKeys(): Promise<Set<string>> {
  const sb = getSupabase();
  const cid = getCompanyId();
  const data = await paginate<{ po_number: string; position: number | null; kind: string }>(
    () => sb.from("decisions").select("po_number, position, kind").eq("company_id", cid),
  );
  const set = new Set<string>();
  for (const d of data) {
    if (d.kind === "accept" || d.kind === "escalate") {
      set.add(`${d.po_number}|${d.position ?? "*"}`);
    }
  }
  return set;
}

export async function upsertChaser(args: {
  poNumber: string;
  position: number | null;
  level?: number;
  status?: "open" | "snoozed" | "resolved";
  snoozeUntil?: string | null;
  action: string;
}): Promise<void> {
  const sb = getSupabase();
  const cid = getCompanyId();
  // PostgREST's `.is()` only accepts null/true/false — a numeric position throws
  // ("failed to parse filter"), which silently forced every position-level chaser
  // down the INSERT branch, duplicating rows instead of updating. Match on the
  // right operator for the value.
  const base = sb.from("chasers").select("*").eq("company_id", cid).eq("po_number", args.poNumber);
  const filtered =
    args.position == null
      ? base.is("position", null)
      : base.eq("position", args.position);
  const { data: existing } = await filtered.limit(1);

  const historyEntry = { at: new Date().toISOString(), action: args.action };

  if (existing && existing.length) {
    const cur = existing[0];
    const history = Array.isArray(cur.history) ? cur.history : [];
    await sb
      .from("chasers")
      .update({
        level: args.level ?? cur.level,
        status: args.status ?? cur.status,
        snooze_until: args.snoozeUntil ?? cur.snooze_until,
        last_level_at:
          args.level && args.level !== cur.level
            ? new Date().toISOString()
            : cur.last_level_at,
        history: [...history, historyEntry],
        updated_at: new Date().toISOString(),
      })
      .eq("id", cur.id);
  } else {
    await sb.from("chasers").insert({
      company_id: cid,
      po_number: args.poNumber,
      position: args.position,
      level: args.level ?? 1,
      status: args.status ?? "open",
      snooze_until: args.snoozeUntil ?? null,
      history: [historyEntry],
    });
  }
}

// A chaser was sent (via the connected mailbox or marked sent by hand): log it,
// hide the PO for the follow-up window, and escalate one step — a sent level-1
// resurfaces as the firm level-2 reminder, a sent level-2 resurfaces as a
// level-3 internal escalation (handled by a colleague, not the supplier), and a
// sent/marked escalation stays at 3 and just re-snoozes so it doesn't reappear
// the next day. An AB arriving meanwhile resolves the chaser via
// closeChasersForPo, so the follow-up never fires spuriously.
export async function markChaserSent(poNumber: string, sentLevel: 1 | 2 | 3): Promise<void> {
  // A sent level-1 hides until the 2nd-reminder window ends; a sent level-2
  // (or re-snoozed escalation) hides for the escalation window.
  const { level2_days, escalation_days } = await getDeadlines();
  const followUpDays = Math.max(1, sentLevel === 1 ? level2_days : escalation_days);
  await upsertChaser({
    poNumber,
    position: null,
    level: Math.min(3, sentLevel + 1),
    status: "snoozed",
    snoozeUntil: addBusinessDays(todayIso(), followUpDays),
    action: `sent_level_${sentLevel}`,
  });
}

export interface ChaserState {
  po_number: string;
  position: number | null;
  level: number;
  status: string;
  snooze_until: string | null;
  last_level_at: string;
}

export async function getChasers(): Promise<Map<string, ChaserState>> {
  const sb = getSupabase();
  const data = await paginate<ChaserState & Record<string, unknown>>(() =>
    sb.from("chasers").select("*").eq("company_id", getCompanyId()),
  );
  const map = new Map<string, ChaserState>();
  for (const c of data) {
    map.set(`${c.po_number}|${c.position ?? "*"}`, c as ChaserState);
  }
  return map;
}

// ── Export (evening CSV): auto-matched + human-approved, one row per position ─

export async function getExportRows(): Promise<ExportRow[]> {
  const sb = getSupabase();
  const cid = getCompanyId();
  const rows = new Map<string, ExportRow>();

  // 1) Auto-matched confirmed dates from the latest match per AB.
  const matches = await paginate<{
    po_number: string;
    positions: unknown;
    overall_bucket: string;
    created_at: unknown;
  }>(() =>
    sb
      .from("matches")
      .select("po_number, positions, overall_bucket, created_at")
      .eq("company_id", cid)
      .order("created_at", { ascending: true }),
  );
  for (const m of matches) {
    const positions = (m.positions as ExportablePosition[]) ?? [];
    for (const p of positions) {
      if (p.bucket === "match" && p.confirmed_date && p.position != null) {
        const key = `${m.po_number}|${p.position}`;
        rows.set(key, {
          po_number: m.po_number as string,
          position: p.position,
          confirmed_date: p.confirmed_date,
          confirmed_qty: p.ordered_qty ?? null,
          confirmed_price: p.unit_price ?? null,
          source: "auto",
        });
      }
    }
  }

  // 2) Human-approved deviations override auto.
  const decisions = await paginate<{
    po_number: string;
    position: number | null;
    confirmed_date: string | null;
    confirmed_qty: number | null;
    confirmed_price: number | null;
    kind: string;
    created_at: unknown;
  }>(() =>
    sb
      .from("decisions")
      .select(
        "po_number, position, confirmed_date, confirmed_qty, confirmed_price, kind, created_at",
      )
      .eq("company_id", cid)
      .eq("kind", "accept")
      .order("created_at", { ascending: true }),
  );
  for (const d of decisions) {
    if (d.position == null || !d.confirmed_date) continue;
    const key = `${d.po_number}|${d.position}`;
    rows.set(key, {
      po_number: d.po_number as string,
      position: d.position as number,
      confirmed_date: d.confirmed_date as string,
      confirmed_qty: (d.confirmed_qty as number) ?? null,
      confirmed_price: (d.confirmed_price as number) ?? null,
      source: "approved",
    });
  }

  return Array.from(rows.values()).sort(
    (a, b) =>
      a.po_number.localeCompare(b.po_number) || a.position - b.position,
  );
}

interface ExportablePosition {
  position: number | null;
  bucket: "match" | "deviation";
  confirmed_date: string | null;
  ordered_qty: number | null;
  unit_price: number | null;
}

export async function recordExportRun(
  filename: string,
  rows: ExportRow[],
): Promise<void> {
  const sb = getSupabase();
  const cid = getCompanyId();
  await sb.from("export_runs").insert({
    company_id: cid,
    filename,
    row_count: rows.length,
    auto_count: rows.filter((r) => r.source === "auto").length,
    approved_count: rows.filter((r) => r.source === "approved").length,
  });
  // Mark the exported lines on the spine so they read as `exported` (Done).
  const now = new Date().toISOString();
  for (const r of rows) {
    await sb
      .from("pos")
      .update({ exported_at: now })
      .eq("company_id", cid)
      .eq("po_number", r.po_number)
      .eq("position", r.position);
  }
}

// ── Import / export history (for the Import/Export screen) ───────────────────
export interface HistoryRow {
  id: string;
  filename: string | null;
  created_at: string;
  counts: Record<string, number>;
}

export async function getImportHistory(limit = 20): Promise<HistoryRow[]> {
  const sb = getSupabase();
  const { data } = await sb
    .from("import_runs")
    .select("id, filename, row_count, created_at")
    .eq("company_id", getCompanyId())
    .order("created_at", { ascending: false })
    .limit(limit);
  return (data ?? []).map((r) => ({
    id: r.id,
    filename: r.filename,
    created_at: r.created_at,
    counts: { lines: r.row_count },
  }));
}

export async function getExportHistory(limit = 20): Promise<HistoryRow[]> {
  const sb = getSupabase();
  const { data } = await sb
    .from("export_runs")
    .select("id, filename, row_count, auto_count, approved_count, created_at")
    .eq("company_id", getCompanyId())
    .order("created_at", { ascending: false })
    .limit(limit);
  return (data ?? []).map((r) => ({
    id: r.id,
    filename: r.filename,
    created_at: r.created_at,
    counts: { rows: r.row_count, auto: r.auto_count, approved: r.approved_count },
  }));
}

export { todayIso };
