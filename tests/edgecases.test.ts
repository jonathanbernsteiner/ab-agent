import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGermanNumber, parseSapCsv } from "@/lib/sap/import";
import { parseDate } from "@/lib/dates";
import { matchAb } from "@/lib/matching";
import { DEFAULT_MAPPING } from "@/lib/sap/mapping";
import type { Extraction, ExtractedPosition, PoLine } from "@/lib/types";

// ── Stress: SAP number parsing ──────────────────────────────────────────────

test("parseGermanNumber handles SAP trailing-minus negatives (credits)", () => {
  assert.equal(parseGermanNumber("45,80-"), -45.8);
  assert.equal(parseGermanNumber("1.234,56-"), -1234.56);
  assert.equal(parseGermanNumber("-45,80"), -45.8);
  assert.equal(parseGermanNumber("45,80"), 45.8);
  assert.equal(parseGermanNumber("€45,80"), 45.8);
  assert.equal(parseGermanNumber("2.400"), 2400);
  assert.equal(parseGermanNumber(""), null);
  assert.equal(parseGermanNumber(","), null);
});

// ── Stress: date validation ─────────────────────────────────────────────────

test("parseDate rejects impossible calendar dates", () => {
  assert.equal(parseDate("31.02.2026"), null); // Feb has no 31st
  assert.equal(parseDate("2026-02-31"), null); // ISO branch validated too
  assert.equal(parseDate("2026-13-01"), null); // month 13
  assert.equal(parseDate("29.02.2026"), null); // 2026 not a leap year
  assert.equal(parseDate("29.02.2024"), "2024-02-29"); // 2024 is a leap year
  assert.equal(parseDate("31.03.2026"), "2026-03-31"); // real date preserved
  assert.equal(parseDate("2026-08-19"), "2026-08-19");
});

test("parseDate bounds calendar-week numbers", () => {
  assert.equal(parseDate("KW 99"), null);
  assert.equal(parseDate("KW 0"), null);
  assert.equal(parseDate("KW 32"), "2026-08-07"); // Friday of ISO week 32, 2026
});

// ── Stress: CSV structure ───────────────────────────────────────────────────

test("parseSapCsv names the missing required column", () => {
  const r = parseSapCsv("Pos;Menge;Preis\n10;100;12,50\n", DEFAULT_MAPPING);
  assert.equal(r.rows.length, 0);
  assert.match(r.warnings.join(" "), /Bestellnummer/);
});

test("parseSapCsv collapses duplicate (po,pos) rows, last wins, and warns", () => {
  const csv = "Bestellnr;Pos;Menge;Preis\n4500;10;100;12,50\n4500;10;999;99,99\n";
  const r = parseSapCsv(csv, DEFAULT_MAPPING);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].unit_price, 99.99); // last wins
  assert.match(r.warnings.join(" "), /doppelte/i);
});

test("parseSapCsv parses a trailing-minus price row end-to-end", () => {
  const csv = "Bestellnr;Pos;Menge;Preis\n4500;10;100;45,80-\n";
  const r = parseSapCsv(csv, DEFAULT_MAPPING);
  assert.equal(r.rows[0].unit_price, -45.8);
});

// ── Stress: matching ────────────────────────────────────────────────────────

function poLine(o: Partial<PoLine> & { position: number }): PoLine {
  return {
    id: `id${o.position}`,
    po_number: "4500",
    article: `ART${o.position}`,
    ordered_qty: 100,
    unit_price: 45.8,
    currency: "EUR",
    requested_date: "2026-08-01",
    ...o,
  } as PoLine;
}
function epos(o: Partial<ExtractedPosition>): ExtractedPosition {
  return {
    position: null,
    article: null,
    description: null,
    quantity: 100,
    unit_price: 45.8,
    currency: null,
    confirmed_delivery_date: "2026-08-01",
    delivery_date_note: null,
    partial_deliveries: [],
    notes: null,
    ...o,
  };
}
function ext(positions: ExtractedPosition[]): Extraction {
  return {
    is_order_confirmation: true,
    language: "de",
    ab_number: "AB1",
    supplier: "S",
    po_number: "4500",
    po_number_context: null,
    positions,
    global_notes: [],
    confidence: "high",
  };
}

test("currency mismatch is a deviation even when the number matches", () => {
  const r = matchAb(
    ext([epos({ position: 10, article: "ART10", unit_price: 45.8, currency: "USD" })]),
    [poLine({ position: 10 })],
  );
  assert.equal(r.overall_bucket, "deviation");
  assert.ok(r.positions[0].findings.some((f) => f.type === "currency_mismatch"));
});

test("same currency (both EUR) produces no currency finding", () => {
  const r = matchAb(
    ext([epos({ position: 10, article: "ART10", currency: "EUR" })]),
    [poLine({ position: 10 })],
  );
  assert.ok(!r.positions[0].findings.some((f) => f.type === "currency_mismatch"));
});

test("a PO line no AB position confirms is surfaced as unconfirmed (partial AB)", () => {
  // PO has lines 10 & 20; AB confirms only line 10 correctly.
  const r = matchAb(
    ext([epos({ position: 10, article: "ART10" })]),
    [poLine({ position: 10 }), poLine({ position: 20, article: "ART20" })],
  );
  assert.equal(r.overall_bucket, "deviation"); // not a silent clean match
  const line20 = r.positions.find((p) => p.position === 20);
  assert.ok(line20, "unconfirmed line 20 is present");
  assert.ok(line20!.findings.some((f) => f.type === "unconfirmed_line"));
  assert.equal(line20!.confirmed_date, null); // nothing to export for it
});

test("an AB confirming every PO line is still a clean match", () => {
  const r = matchAb(
    ext([epos({ position: 10, article: "ART10" }), epos({ position: 20, article: "ART20" })]),
    [poLine({ position: 10 }), poLine({ position: 20, article: "ART20" })],
  );
  assert.equal(r.overall_bucket, "match");
  assert.ok(!r.positions.some((p) => p.findings.some((f) => f.type === "unconfirmed_line")));
});

test("a bonus AB position matching no PO line is flagged extra, not force-bound", () => {
  // PO has lines 10 & 20; AB confirms 10 correctly and adds a bonus line 99
  // (no position/article match). The bonus must NOT be bound to line 20.
  const r = matchAb(
    ext([
      epos({ position: 10, article: "ART10" }),
      epos({ position: 99, article: "ZZZ", quantity: 5, unit_price: 80, confirmed_delivery_date: "2026-09-01" }),
    ]),
    [poLine({ position: 10 }), poLine({ position: 20, article: "ART20" })],
  );
  const bonus = r.positions.find((p) => p.position === 99);
  assert.ok(bonus, "bonus position present");
  assert.ok(
    bonus!.findings.some((f) => f.type === "extra_position"),
    "bonus flagged as extra_position",
  );
  // It must not have produced spurious price/qty findings against line 20.
  assert.ok(!bonus!.findings.some((f) => f.type === "qty_mismatch" || f.type === "price_increase"));
});
