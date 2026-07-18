import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  runImport,
  recordDecision,
  getAcceptedKeys,
  getExportRows,
  getActivePoLines,
  upsertChaser,
  getChasers,
} from "@/lib/store";
import { getAwaiting } from "@/lib/readmodel";
import { installFakeDb } from "./helpers/harness";
import type { PoLine } from "@/lib/types";

// A realistic three-day operating cycle. The point is to prove the persistence
// contract the daily SAP import must honour:
//   - imports refresh FACTS on existing PO lines (keyed by po_number+position)
//   - human decisions, notes, snoozes, and chaser reminders live in separate
//     tables keyed to the PO and SURVIVE every re-import
//   - a line missing from today's export is archived, never deleted, and
//     re-appears (un-archives) if it shows up again
//   - once SAP itself confirms a date, the line drops off the active queue

function line(o: Partial<PoLine> & { po_number: string; position: number }): PoLine {
  return {
    po_number: o.po_number,
    position: o.position,
    article: o.article ?? `ART-${o.po_number}-${o.position}`,
    article_desc: o.article_desc ?? "Teil",
    ordered_qty: o.ordered_qty ?? 100,
    unit_price: o.unit_price ?? 10,
    currency: o.currency ?? "EUR",
    requested_date: o.requested_date ?? "2026-08-01",
    po_date: o.po_date ?? "2026-07-01",
    supplier: o.supplier ?? "ACME",
    confirmed_date: o.confirmed_date ?? null,
  } as PoLine;
}

beforeEach(() => {
  installFakeDb();
});

test("3-day cycle: decisions, snoozes and chasers survive every daily re-import", async () => {
  // ── Day 1: three POs arrive, all open, none confirmed ──────────────────────
  await runImport(
    [
      line({ po_number: "PO-A", position: 10 }),
      line({ po_number: "PO-B", position: 10 }),
      line({ po_number: "PO-C", position: 10 }),
    ],
    "day1.csv",
    {},
  );

  // Günther accepts a deviation on PO-A and snoozes a chaser on PO-B ("remind
  // her in a few days"). These are the human notes that must never be lost.
  await recordDecision({
    poNumber: "PO-A",
    position: 10,
    abId: null,
    kind: "accept",
    confirmedDate: "2026-08-10",
    confirmedQty: 100,
    confirmedPrice: 10,
  });
  await upsertChaser({
    poNumber: "PO-B",
    position: null,
    status: "snoozed",
    snoozeUntil: "2026-07-20",
    action: "snooze_note",
  });

  // ── Day 2: PO-C is gone from SAP (closed) → archived. A + B re-imported. ────
  const day2 = await runImport(
    [line({ po_number: "PO-A", position: 10 }), line({ po_number: "PO-B", position: 10 })],
    "day2.csv",
    {},
  );
  assert.equal(day2.archived, 1, "PO-C archived, not deleted");
  assert.equal(day2.inserted, 0, "existing lines are updates, not inserts");

  // The decision and the chaser survived the re-import untouched.
  const accepted = await getAcceptedKeys();
  assert.ok(accepted.has("PO-A|10"), "accepted decision survived re-import");
  const chasers = await getChasers();
  assert.equal(chasers.get("PO-B|*")?.status, "snoozed", "snoozed chaser survived");
  assert.equal(chasers.get("PO-B|*")?.snooze_until, "2026-07-20");

  // PO-A's accepted date is still queued for the evening export.
  const exp2 = await getExportRows();
  assert.deepEqual(
    exp2.find((r) => r.po_number === "PO-A"),
    { po_number: "PO-A", position: 10, confirmed_date: "2026-08-10", confirmed_qty: 100, confirmed_price: 10, source: "approved" },
  );

  // ── Day 3: PO-C reappears (un-archives); SAP confirms PO-B overnight ────────
  const day3 = await runImport(
    [
      line({ po_number: "PO-A", position: 10 }),
      line({ po_number: "PO-B", position: 10, confirmed_date: "2026-08-15" }), // SAP confirms
      line({ po_number: "PO-C", position: 10 }), // back again
    ],
    "day3.csv",
    {},
  );
  assert.equal(day3.confirmedBySap, 1, "PO-B now confirmed by SAP");

  const cLines = await getActivePoLines("PO-C");
  assert.equal(cLines.length, 1, "PO-C is active again (un-archived), not duplicated");
  assert.equal(cLines[0].status, "awaiting");

  // Decision + chaser STILL there after a third import.
  assert.ok((await getAcceptedKeys()).has("PO-A|10"), "decision persists to day 3");
  assert.ok((await getChasers()).get("PO-B|*"), "chaser record persists to day 3");

  // PO-B, now SAP-confirmed, is no longer in the awaiting/overdue queue.
  const awaiting = await getAwaiting();
  const stillWaiting = [...awaiting.overdue, ...awaiting.pending].map((c) => c.poNumber);
  assert.ok(!stillWaiting.includes("PO-B"), "SAP-confirmed PO-B left the active queue");
});

test("a decided line that leaves and returns keeps its decision (not resurrected as new)", async () => {
  await runImport([line({ po_number: "PO-X", position: 10 })], "d1.csv", {});
  await recordDecision({
    poNumber: "PO-X",
    position: 10,
    abId: null,
    kind: "accept",
    confirmedDate: "2026-08-01",
    confirmedQty: 100,
    confirmedPrice: 10,
  });

  // leaves the export (archived) …
  await runImport([line({ po_number: "PO-Y", position: 10 })], "d2.csv", {});
  // … then comes back
  await runImport([line({ po_number: "PO-X", position: 10 })], "d3.csv", {});

  const accepted = await getAcceptedKeys();
  assert.ok(accepted.has("PO-X|10"), "the original decision still applies to the returned line");

  // and it's still the approved export row (one, not duplicated).
  const rows = (await getExportRows()).filter((r) => r.po_number === "PO-X");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "approved");
});
