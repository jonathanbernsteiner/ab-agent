import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { decodeCsv, parseSapCsv } from "@/lib/sap/import";
import { DEFAULT_MAPPING } from "@/lib/sap/mapping";
import {
  runImport,
  recordDecision,
  getAcceptedKeys,
  getExportRows,
  getQueuedDate,
  getActivePoLines,
  upsertChaser,
  getChasers,
} from "@/lib/store";
import { installFakeDb, readFixtureBytes } from "./helpers/harness";
import type { FakeSupabase } from "./helpers/fake-supabase";

const DOT_MAPPING = { ...DEFAULT_MAPPING, decimal_sep: "." };

function importDay(file: string) {
  const { rows } = parseSapCsv(decodeCsv(readFixtureBytes(`po-exports/${file}`)), DOT_MAPPING);
  return runImport(rows, file, DOT_MAPPING);
}

let db: FakeSupabase;
beforeEach(() => {
  db = installFakeDb();
});

test("day-1 import inserts every line and marks SAP-confirmed lines", async () => {
  const summary = await importDay("open_POs_export.csv");
  assert.equal(summary.inserted, 34);
  assert.equal(summary.updated, 0);
  assert.equal(summary.archived, 0);
  // 7 day-1 lines arrive already confirmed by SAP.
  assert.equal(summary.confirmedBySap, 7);

  const hart = await getActivePoLines("4500112901");
  assert.equal(hart.length, 1);
  assert.equal(hart[0].status, "awaiting");
});

test("an accepted deviation survives a re-import and is not resurrected", async () => {
  await importDay("open_POs_export.csv");

  // Günther accepts Hartmann's +7-day / split confirmation for 4500112901/10.
  await recordDecision({
    poNumber: "4500112901",
    position: 10,
    abId: null,
    kind: "accept",
    confirmedDate: "2026-08-05",
    confirmedQty: 800,
    confirmedPrice: 45.8,
  });

  // Decision is queued for export.
  assert.equal(await getQueuedDate("4500112901", 10), "2026-08-05");
  assert.ok((await getAcceptedKeys()).has("4500112901|10"));
  let exp = await getExportRows();
  const before = exp.find((r) => r.po_number === "4500112901" && r.position === 10);
  assert.ok(before, "approved row present before re-import");
  assert.equal(before!.source, "approved");
  assert.equal(before!.confirmed_date, "2026-08-05");

  const decisionsBefore = db.count("decisions");

  // Morning day-2 import runs.
  await importDay("open_POs_export_day2.csv");

  // The decision is untouched — imports update FACTS, never DECISIONS.
  assert.equal(db.count("decisions"), decisionsBefore, "no decision was added or deleted");
  assert.equal(await getQueuedDate("4500112901", 10), "2026-08-05", "decision still queued");
  assert.ok((await getAcceptedKeys()).has("4500112901|10"), "still accepted");
  exp = await getExportRows();
  const after = exp.find((r) => r.po_number === "4500112901" && r.position === 10);
  assert.ok(after, "approved row survives re-import (not resurrected as undecided)");
  assert.equal(after!.confirmed_date, "2026-08-05");
});

test("a PO that SAP confirms overnight drops off the active queue", async () => {
  await importDay("open_POs_export.csv");
  // Day 1: 4500112873 is open and awaiting confirmation.
  let lines = await getActivePoLines("4500112873");
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => l.status === "awaiting"));

  await importDay("open_POs_export_day2.csv");

  // Day 2: SAP shows it confirmed -> status flips to confirmed (off the queue).
  lines = await getActivePoLines("4500112873");
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => l.status === "confirmed"), "both positions confirmed");
  assert.ok(lines.every((l) => l.confirmed_date === "2026-07-24"));
});

test("SAP confirming a different date than the tool queued is flagged externally_changed", async () => {
  await importDay("open_POs_export.csv");

  // Tool had queued 30.07 for 4500112873/10, but SAP will show 24.07 on day 2.
  await recordDecision({
    poNumber: "4500112873",
    position: 10,
    abId: null,
    kind: "accept",
    confirmedDate: "2026-07-30",
  });
  assert.equal(await getQueuedDate("4500112873", 10), "2026-07-30");

  const summary = await importDay("open_POs_export_day2.csv");
  assert.ok(summary.externallyChanged >= 1, "at least one externally-changed line");

  const line = (await getActivePoLines("4500112873")).find((l) => l.position === 10);
  assert.ok(line);
  assert.equal(line!.status, "externally_changed");
  assert.equal(line!.external_confirmed_date, "2026-07-24");
  // The human decision is not destroyed by the import.
  assert.ok((await getAcceptedKeys()).has("4500112873|10"));
});

test("chasers persist across a re-import even when the PO leaves the export", async () => {
  await importDay("open_POs_export.csv");

  // An overdue PO gets a level-1 chaser drafted.
  await upsertChaser({
    poNumber: "4500112990",
    position: null,
    level: 1,
    status: "open",
    action: "level1_drafted",
  });
  assert.ok((await getChasers()).has("4500112990|*"));

  // 4500112990 is absent from the day-2 export (its pos line archives)...
  await importDay("open_POs_export_day2.csv");

  // ...but its chaser, keyed to the PO, survives untouched.
  const chasers = await getChasers();
  assert.ok(chasers.has("4500112990|*"), "chaser survives");
  assert.equal(chasers.get("4500112990|*")!.status, "open");
});
