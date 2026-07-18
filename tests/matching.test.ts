import { test } from "node:test";
import assert from "node:assert/strict";
import { matchAb } from "@/lib/matching";
import { buildChaser, buildPushback } from "@/lib/chaser";
import type {
  Extraction,
  ExtractedPosition,
  Finding,
  FindingType,
  PoLine,
} from "@/lib/types";

// ── synthetic builders (deterministic; these test MATCHING, not extraction) ──
function ext(over: Partial<Extraction> & { positions: ExtractedPosition[] }): Extraction {
  return {
    is_order_confirmation: true,
    language: "de",
    ab_number: "AB-1",
    supplier: "Test GmbH",
    po_number: "4500112901",
    po_number_context: null,
    global_notes: [],
    confidence: "high",
    ...over,
  };
}
function epos(over: Partial<ExtractedPosition>): ExtractedPosition {
  return {
    position: 10,
    article: null,
    description: null,
    quantity: null,
    unit_price: null,
    currency: "EUR",
    confirmed_delivery_date: null,
    delivery_date_note: null,
    partial_deliveries: [],
    notes: null,
    ...over,
  };
}
function po(over: Partial<PoLine>): PoLine {
  return {
    id: "po-1",
    po_number: "4500112901",
    position: 10,
    article: null,
    article_desc: null,
    ordered_qty: null,
    unit_price: null,
    currency: "EUR",
    requested_date: null,
    po_date: null,
    supplier: "Test GmbH",
    ...over,
  };
}
const types = (fs: Finding[]): FindingType[] => fs.map((f) => f.type);

test("perfect confirmation is a clean match with no findings", () => {
  const r = matchAb(
    ext({ positions: [epos({ quantity: 2400, unit_price: 3.85, confirmed_delivery_date: "2026-07-24" })] }),
    [po({ ordered_qty: 2400, unit_price: 3.85, requested_date: "2026-07-24" })],
  );
  assert.equal(r.overall_bucket, "match");
  assert.deepEqual(r.positions[0].findings, []);
  assert.equal(r.positions[0].confirmed_date, "2026-07-24");
});

test("a later confirmed date is a date_later deviation", () => {
  const r = matchAb(
    ext({ positions: [epos({ quantity: 2400, unit_price: 3.85, confirmed_delivery_date: "2026-07-26" })] }),
    [po({ ordered_qty: 2400, unit_price: 3.85, requested_date: "2026-07-24" })],
  );
  assert.equal(r.overall_bucket, "deviation");
  assert.deepEqual(types(r.positions[0].findings), ["date_later"]);
  assert.equal(r.positions[0].findings[0].detail?.days, 2);
});

test("price within 0.5% tolerance does not fire; beyond it does", () => {
  const within = matchAb(
    ext({ positions: [epos({ quantity: 800, unit_price: 45.9, confirmed_delivery_date: "2026-07-29" })] }),
    [po({ ordered_qty: 800, unit_price: 45.8, requested_date: "2026-07-29" })],
  );
  assert.equal(within.overall_bucket, "match", "0.22% is within tolerance");

  const beyond = matchAb(
    ext({ positions: [epos({ quantity: 800, unit_price: 47.2, confirmed_delivery_date: "2026-07-29" })] }),
    [po({ ordered_qty: 800, unit_price: 45.8, requested_date: "2026-07-29" })],
  );
  const f = beyond.positions[0].findings.find((x) => x.type === "price_increase");
  assert.ok(f, "price_increase fired");
  assert.ok((f!.detail?.pct as number) > 3 && (f!.detail?.pct as number) < 3.2, "~3.1%");
});

test("a quantity that differs from ordered is a qty_mismatch", () => {
  const r = matchAb(
    ext({ positions: [epos({ quantity: 750, confirmed_delivery_date: "2026-07-29" })] }),
    [po({ ordered_qty: 800, requested_date: "2026-07-29" })],
  );
  assert.ok(types(r.positions[0].findings).includes("qty_mismatch"));
});

test("no confirmable date + prose 'kann nicht' yields unconfirmed_date", () => {
  const r = matchAb(
    ext({ positions: [epos({ notes: "Der Wunschtermin kann leider nicht bestätigt werden." })] }),
    [po({ ordered_qty: 800, requested_date: "2026-07-29" })],
  );
  const f = r.positions[0].findings.find((x) => x.type === "unconfirmed_date");
  assert.ok(f);
  assert.match(f!.human, /nicht möglich/);
});

test("Hartmann shape: split + late + prose price = exactly 3 finding types", () => {
  // This mirrors the ground truth in expected/hartmann_findings.json but feeds a
  // synthetic extraction so it isolates the MATCHING side (the real model read
  // is exercised by the gated pipeline test).
  const r = matchAb(
    ext({
      positions: [
        epos({
          quantity: null,
          unit_price: 47.2, // stated in prose (Metallzuschlag), not the table
          confirmed_delivery_date: null,
          partial_deliveries: [
            { quantity: 500, delivery_date: "2026-08-05", delivery_date_note: null },
            { quantity: 300, delivery_date: "2026-08-19", delivery_date_note: null },
          ],
          notes: "Aufgrund gestiegener Rohstoffpreise Metallzuschlag, Preis nun 47,20 EUR",
        }),
      ],
    }),
    [po({ ordered_qty: 800, unit_price: 45.8, requested_date: "2026-07-29" })],
  );
  assert.equal(r.overall_bucket, "deviation");
  const t = new Set(types(r.positions[0].findings));
  assert.ok(t.has("date_later"), "late delivery detected");
  assert.ok(t.has("partial_split"), "partial split detected");
  assert.ok(t.has("price_increase"), "prose price increase detected");
  assert.equal(t.size, 3, "exactly the three expected finding kinds");
  // total confirmed qty equals ordered -> the split is NOT a qty mismatch.
  assert.ok(!t.has("qty_mismatch"));
});

test("not-an-AB / unknown PO resolves to the no_po bucket", () => {
  const notAb = matchAb(ext({ is_order_confirmation: false, positions: [] }), [po({})]);
  assert.equal(notAb.overall_bucket, "no_po");

  const noLines = matchAb(ext({ positions: [epos({})] }), []);
  assert.equal(noLines.overall_bucket, "no_po");
});

test("chaser and pushback drafts carry the concrete PO facts", () => {
  const line = po({ supplier: "Gusswerk Hartmann GmbH & Co. KG", article: "WS-4411-C", requested_date: "2026-07-29", po_date: "2026-07-08" });

  const l1 = buildChaser(line, 1);
  assert.match(l1.subject, /4500112901/);
  assert.match(l1.subject, /ausstehend/i);
  assert.match(l1.body, /Gusswerk Hartmann/);

  const l2 = buildChaser(line, 2);
  assert.match(l2.subject, /2\. Erinnerung|Frist/);
  assert.match(l2.body, /Frist|verbindlich/);

  const pb = buildPushback(line, [
    { type: "price_increase", severity: "warn", human: "Preis +3,1%: 45,80 → 47,20 EUR" },
  ]);
  assert.match(pb.body, /Preis \+3,1%/);
});
