import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { matchAb } from "@/lib/matching";
import { extractionFromRaw } from "@/lib/extraction/extract";
import {
  runImport,
  persistAb,
  recomputePo,
  recordDecision,
  getActivePoLines,
  confirmedPositions,
} from "@/lib/store";
import { getMatching } from "@/lib/views";
import { isoDateOf } from "@/lib/dates";
import { installFakeDb } from "./helpers/harness";
import type { PoLine } from "@/lib/types";

// Exercises the materialized line-grain "Matching" spine end-to-end WITHOUT the
// LLM: raw AB payloads are matched with the real matcher, persisted, and folded
// onto the spine by recomputePo — the same functions the pipeline calls.

function line(o: Partial<PoLine> & { po_number: string; position: number }): PoLine {
  return {
    po_number: o.po_number,
    position: o.position,
    article: o.article ?? `ART-${o.position}`,
    article_desc: "Teil",
    ordered_qty: o.ordered_qty ?? 100,
    unit_price: o.unit_price ?? 10,
    currency: "EUR",
    requested_date: o.requested_date ?? "2026-08-01",
    po_date: o.po_date ?? "2026-07-11",
    supplier: o.supplier ?? "ACME",
    confirmed_date: o.confirmed_date ?? null,
  } as PoLine;
}

let hashSeq = 0;
function rawAb(o: {
  po: string;
  ab?: string;
  positions: { position: number; quantity?: number; unit_price?: number; date: string | null }[];
}) {
  return {
    is_order_confirmation: true,
    language: "de",
    ab_number: o.ab ?? "AB-1",
    supplier: "ACME",
    po_number: o.po,
    positions: o.positions.map((p) => ({
      position: p.position,
      article: `ART-${p.position}`,
      quantity: p.quantity ?? 100,
      unit_price: p.unit_price ?? 10,
      currency: "EUR",
      confirmed_delivery_date: p.date,
      partial_deliveries: [],
      notes: null,
    })),
    global_notes: [],
    confidence: "high",
  };
}

// Simulate one AB ingest the way pipeline.ingestDocument does (minus the model).
async function ingest(raw: ReturnType<typeof rawAb>) {
  const extraction = extractionFromRaw(raw);
  const poLines = await getActivePoLines(extraction.po_number!);
  const match = matchAb(extraction, poLines, confirmedPositions(poLines));
  const docKind = extraction.is_order_confirmation && extraction.po_number ? "ab" : "not_ab";
  const abId = await persistAb({
    contentHash: `hash-${++hashSeq}`,
    source: "upload",
    abNumber: extraction.ab_number,
    supplier: extraction.supplier,
    poNumber: extraction.po_number,
    docKind,
    model: "test",
    rawOutput: raw,
    transcript: "",
    match,
  });
  if (match.overall_bucket !== "no_po") await recomputePo(extraction.po_number!);
  return { abId, match };
}

function cardFor(data: Awaited<ReturnType<typeof getMatching>>, po: string) {
  return data.cards.find((c) => c.poNumber === po)!;
}

beforeEach(() => {
  installFakeDb();
});

test("a clean confirmation makes the PO 'confirmed' with no Inbox queue", async () => {
  await runImport([line({ po_number: "4500000001", position: 10 })], "d1.csv", {});
  await ingest(rawAb({ po: "4500000001", positions: [{ position: 10, date: "2026-07-20" }] }));

  const m = await getMatching();
  const c = cardFor(m, "4500000001");
  assert.equal(c.status, "confirmed");
  assert.equal(c.confirmedDate, "2026-07-20");
  assert.equal(c.queue, null, "a clean confirmation needs no human");
  assert.equal(m.counts.inbox, 0);
});

test("a deviating confirmation queues the PO under 'decide'", async () => {
  await runImport([line({ po_number: "4500000002", position: 10, requested_date: "2026-08-01" })], "d1.csv", {});
  // Confirmed a week later than requested → date_later deviation.
  await ingest(rawAb({ po: "4500000002", positions: [{ position: 10, date: "2026-08-08" }] }));

  const m = await getMatching();
  const c = cardFor(m, "4500000002");
  assert.equal(c.status, "to_review");
  assert.equal(c.queue, "decide");
  assert.match(c.keyFindings ?? "", /Date/);
});

test("a PO with one deviating line among several shows 'x of y' and queues 'decide'", async () => {
  await runImport(
    [
      line({ po_number: "4500000006", position: 10, requested_date: "2026-08-01" }),
      line({ po_number: "4500000006", position: 20, requested_date: "2026-08-01" }),
    ],
    "d1.csv",
    {},
  );
  // Line 10 on time (clean), line 20 a week late (deviation).
  await ingest(
    rawAb({
      po: "4500000006",
      positions: [
        { position: 10, date: "2026-07-25" },
        { position: 20, date: "2026-08-08" },
      ],
    }),
  );

  const c = cardFor(await getMatching(), "4500000006");
  assert.equal(c.lineCount, 2);
  assert.equal(c.deviatingCount, 1);
  assert.equal(c.status, "to_review", "worst line status wins");
  assert.equal(c.queue, "decide");
  assert.match(c.keyFindings ?? "", /1 of 2 lines/);
});

test("accepting a deviation confirms the PO and clears its queue", async () => {
  await runImport([line({ po_number: "4500000003", position: 10, requested_date: "2026-08-01" })], "d1.csv", {});
  await ingest(rawAb({ po: "4500000003", positions: [{ position: 10, date: "2026-08-08" }] }));
  await recordDecision({
    poNumber: "4500000003",
    position: 10,
    abId: null,
    kind: "accept",
    confirmedDate: "2026-08-08",
    confirmedQty: 100,
    confirmedPrice: 10,
  });

  const c = cardFor(await getMatching(), "4500000003");
  assert.equal(c.status, "confirmed");
  assert.equal(c.queue, null);
});

test("an AB whose PO isn't imported yet is a 'waiting_import' card, then auto-rematches on import", async () => {
  // AB arrives first — its PO is not in SAP yet.
  await ingest(rawAb({ po: "4500000004", positions: [{ position: 10, date: "2026-08-08" }] }));

  let m = await getMatching();
  let c = cardFor(m, "4500000004");
  assert.equal(c.status, "waiting_import", "unmatched AB shows as a normal card");
  assert.equal(c.lineCount, 0, "no spine lines yet");
  assert.ok(c.abId, "opens the AB drawer");
  assert.equal(c.queue, null, "fresh unmatched AB needs nobody — next import resolves it");

  // The PO is imported — no human step; runImport re-matches the waiting AB.
  await runImport([line({ po_number: "4500000004", position: 10, requested_date: "2026-08-01" })], "d2.csv", {});

  m = await getMatching();
  assert.ok(!m.cards.some((x) => x.status === "waiting_import"), "the AB left the waiting queue");
  c = cardFor(m, "4500000004");
  assert.equal(c.status, "to_review", "late confirmation folded onto the freshly-imported line");
  assert.equal(c.confirmedDate, "2026-08-08");
});

test("a new AB for an already-confirmed line supersedes it back to 'decide'", async () => {
  await runImport([line({ po_number: "4500000005", position: 10, requested_date: "2026-08-10" })], "d1.csv", {});
  // First AB: on time → clean → confirmed.
  await ingest(rawAb({ po: "4500000005", ab: "AB-1", positions: [{ position: 10, date: "2026-08-05" }] }));
  assert.equal(cardFor(await getMatching(), "4500000005").status, "confirmed");

  // Second AB for the same line → must re-enter review (superseded), not silently overwrite.
  await ingest(rawAb({ po: "4500000005", ab: "AB-2", positions: [{ position: 10, date: "2026-08-20" }] }));

  const c = cardFor(await getMatching(), "4500000005");
  assert.equal(c.status, "to_review");
  assert.equal(c.queue, "decide");
  assert.match(c.keyFindings ?? "", /Superseded/);
});

test("silent POs queue under 'chase', and under 'escalate' once level 3 is reached", async () => {
  // Ancient PO (far past overdue + 2× follow-up window) → level 3 by time alone,
  // stable no matter when the suite runs. The chase PO is placed 6 calendar days
  // ago: any 7-date span crosses a weekend, so it waits 4–5 business days —
  // always past the overdue grace (3) but never at the level-2/3 thresholds.
  const chasePoDate = isoDateOf(Date.now() - 6 * 86400000);
  await runImport(
    [
      line({ po_number: "4500000007", position: 10, po_date: "2026-01-05", requested_date: "2026-03-01" }),
      line({ po_number: "4500000008", position: 10, po_date: chasePoDate, requested_date: "2026-08-01" }),
    ],
    "d1.csv",
    {},
  );

  const m = await getMatching();
  const escalated = cardFor(m, "4500000007");
  assert.equal(escalated.status, "overdue");
  assert.equal(escalated.queue, "escalate", "two-reminders-past silence escalates internally");
  assert.match(escalated.keyFindings ?? "", /escalate/i);

  const chased = cardFor(m, "4500000008");
  assert.equal(chased.status, "overdue");
  assert.equal(chased.queue, "chase", "recently-overdue PO is a normal chase");
});
