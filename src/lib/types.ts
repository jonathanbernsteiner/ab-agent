// Shared domain types for the AB Agent.

export type Bucket = "match" | "deviation" | "no_po";

// ── Line-grain "Matching" spine status ──────────────────────────────────────
// Stored on the pos line (the sole writer is recomputeLineState in store.ts):
export type MatchStatus =
  | "awaiting" // ordered, no confirmation yet
  | "to_review" // a confirmation deviates and no one has decided
  | "confirmed" // clean auto-match, accepted deviation, or SAP-confirmed
  | "externally_changed" // SAP overwrote the date the tool wrote
  | "archived"; // dropped out of the SAP import (kept, never deleted)

// Effective status shown in the UI — the two extra values are derived at read
// time, never stored: `overdue` = awaiting + past grace + not snoozed;
// `exported` = confirmed + exported_at set.
export type EffectiveStatus = MatchStatus | "overdue" | "exported";

// Whether a line needs a human — a pure function of the effective status.
export function needsHuman(status: EffectiveStatus): boolean {
  return (
    status === "to_review" ||
    status === "overdue" ||
    status === "externally_changed"
  );
}

// Retained alias — `pos.status` now carries MatchStatus values.
export type PoStatus = MatchStatus;

// ── SAP purchase-order line ────────────────────────────────────────────────
export interface PoLine {
  id?: string;
  po_number: string;
  position: number;
  article: string | null;
  article_desc: string | null;
  ordered_qty: number | null;
  unit_price: number | null;
  currency: string;
  requested_date: string | null; // ISO yyyy-mm-dd
  po_date: string | null; // ISO
  supplier: string | null;
  confirmed_date?: string | null;
  confirmed_source?: string | null;
  external_confirmed_date?: string | null;
  status?: PoStatus;
  // Promoted confirmation facts (materialized by recomputeLineState).
  confirmed_qty?: number | null;
  confirmed_price?: number | null;
  findings?: Finding[]; // unresolved deviations on this line (empty once clean/accepted)
  findings_summary?: string | null; // one-line English summary for the table cell
  source_ab_id?: string | null; // the AB that set the current confirmation
  exported_at?: string | null; // set when written to the SAP evening CSV
}

// ── Extraction output (the model's structured read of one document) ─────────
export interface ExtractedPartial {
  quantity: number;
  delivery_date: string | null; // ISO
  delivery_date_note?: string | null; // e.g. "aus KW 34"
}

export interface ExtractedPosition {
  position: number | null;
  article: string | null;
  description: string | null;
  quantity: number | null;
  unit_price: number | null;
  currency: string | null;
  confirmed_delivery_date: string | null; // ISO
  delivery_date_note: string | null; // e.g. calendar-week note
  partial_deliveries: ExtractedPartial[];
  notes: string | null; // prose findings tied to this line (price change, "cannot confirm")
}

export interface Extraction {
  is_order_confirmation: boolean;
  language: "de" | "en" | "other" | null;
  ab_number: string | null;
  supplier: string | null;
  po_number: string | null;
  po_number_context: string | null; // where the PO number was found (prose vs table)
  positions: ExtractedPosition[];
  global_notes: string[]; // document-level prose findings
  confidence: "high" | "medium" | "low";
}

// ── Match findings ─────────────────────────────────────────────────────────
export type FindingType =
  | "date_later"
  | "partial_split"
  | "price_increase"
  | "price_decrease"
  | "qty_mismatch"
  | "currency_mismatch"
  | "unconfirmed_date"
  | "unconfirmed_line"
  | "no_po_line"
  | "extra_position"
  | "superseded"; // a newer AB replaced an already-confirmed line

export interface Finding {
  type: FindingType;
  severity: "info" | "warn";
  human: string; // human-readable, German
  detail?: Record<string, unknown>;
}

export interface PositionResult {
  position: number | null;
  po_id: string | null;
  article: string | null;
  ordered_qty: number | null;
  extracted_qty: number | null;
  unit_price: number | null;
  extracted_price: number | null;
  requested_date: string | null;
  confirmed_date: string | null; // date to queue for export (if resolvable)
  partials: ExtractedPartial[];
  bucket: "match" | "deviation";
  findings: Finding[];
}

export interface MatchResult {
  overall_bucket: Bucket;
  po_number: string | null;
  positions: PositionResult[];
}

// ── Matching tolerances (spec §Behavior details) ────────────────────────────
export const PRICE_TOLERANCE = 0.005; // 0.5%
export const OVERDUE_BUSINESS_DAYS = 3; // silent for 3 business days after PO date
export const LEVEL2_BUSINESS_DAYS = 3; // 3 further days of silence → level-2 chaser
