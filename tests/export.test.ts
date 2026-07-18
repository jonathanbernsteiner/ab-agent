import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { persistAb, recordDecision, getExportRows } from "@/lib/store";
import { buildExportCsv } from "@/lib/sap/export";
import { installFakeDb } from "./helpers/harness";
import type { MatchResult } from "@/lib/types";

beforeEach(() => {
  installFakeDb();
});

// An auto-matched confirmation, as pipeline.persistAb would write it.
const autoMatch: MatchResult = {
  overall_bucket: "match",
  po_number: "4500113001",
  positions: [
    {
      position: 10,
      po_id: "po-x",
      article: "MT-7736-B",
      ordered_qty: 1800,
      extracted_qty: 1800,
      unit_price: 4.1,
      extracted_price: 4.1,
      requested_date: "2026-07-28",
      confirmed_date: "2026-07-28",
      partials: [],
      bucket: "match",
      findings: [],
    },
  ],
};

async function seedAutoMatch() {
  await persistAb({
    contentHash: "hash-auto-1",
    source: "upload",
    abNumber: "AB-X",
    supplier: "MetallTech Präzision GmbH",
    poNumber: "4500113001",
    docKind: "ab",
    model: "test",
    rawOutput: {},
    transcript: "",
    match: autoMatch,
  });
}

test("an auto-matched line becomes an 'auto' export row with PO facts", async () => {
  await seedAutoMatch();
  const rows = await getExportRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "auto");
  assert.equal(rows[0].confirmed_date, "2026-07-28");
  assert.equal(rows[0].confirmed_qty, 1800);
  assert.equal(rows[0].confirmed_price, 4.1);

  const csv = buildExportCsv(rows);
  assert.match(csv, /Bestellnr;Pos;Bestaetigt;Menge;Preis;Quelle/);
  assert.match(csv, /4500113001;10;28\.07\.2026;1800,00;4,10;Auto/);
  assert.ok(csv.startsWith("﻿"), "BOM for Excel");
});

test("a human-approved decision overrides the auto row for the same line", async () => {
  await seedAutoMatch();
  await recordDecision({
    poNumber: "4500113001",
    position: 10,
    abId: null,
    kind: "accept",
    confirmedDate: "2026-08-01",
    confirmedQty: 1800,
    confirmedPrice: 4.3,
  });

  const rows = await getExportRows();
  assert.equal(rows.length, 1, "still one row per position, not duplicated");
  assert.equal(rows[0].source, "approved");
  assert.equal(rows[0].confirmed_date, "2026-08-01");
  assert.equal(rows[0].confirmed_price, 4.3);

  const csv = buildExportCsv(rows);
  assert.match(csv, /4500113001;10;01\.08\.2026;1800,00;4,30;Freigegeben/);
});
