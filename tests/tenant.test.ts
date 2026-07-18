import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { runImport, recordDecision, getActivePoLines, getExportRows } from "@/lib/store";
import { getMatching } from "@/lib/views";
import { runWithCompany } from "@/lib/tenant";
import { installFakeDb } from "./helpers/harness";
import type { PoLine } from "@/lib/types";

// Multi-tenant isolation: two companies can hold the SAME PO number with totally
// different facts, and nothing from one is ever visible to the other.

function line(po: string, price: number, supplier: string): PoLine {
  return {
    po_number: po, position: 10, article: "ART", article_desc: "Teil",
    ordered_qty: 100, unit_price: price, currency: "EUR",
    requested_date: "2026-08-01", po_date: "2026-07-01", supplier, confirmed_date: null,
  } as PoLine;
}

beforeEach(() => {
  installFakeDb();
});

test("two companies with the same PO number never see each other's data", async () => {
  const A = "company-A";
  const B = "company-B";

  await runWithCompany(A, () => runImport([line("4500999999", 10, "Alpha GmbH")], "a.csv", {}));
  await runWithCompany(B, () => runImport([line("4500999999", 999, "Beta AG")], "b.csv", {}));

  // Same PO number, different tenant → different facts.
  const aLine = await runWithCompany(A, () => getActivePoLines("4500999999"));
  const bLine = await runWithCompany(B, () => getActivePoLines("4500999999"));
  assert.equal(aLine.length, 1);
  assert.equal(bLine.length, 1);
  assert.equal(aLine[0].supplier, "Alpha GmbH");
  assert.equal(aLine[0].unit_price, 10);
  assert.equal(bLine[0].supplier, "Beta AG");
  assert.equal(bLine[0].unit_price, 999);

  // A decision recorded for A must not affect B's export.
  await runWithCompany(A, () =>
    recordDecision({ poNumber: "4500999999", position: 10, abId: null, kind: "accept", confirmedDate: "2026-08-05", confirmedQty: 100, confirmedPrice: 10 }),
  );
  const aExport = await runWithCompany(A, () => getExportRows());
  const bExport = await runWithCompany(B, () => getExportRows());
  assert.equal(aExport.length, 1, "A has its approved row");
  assert.equal(bExport.length, 0, "B sees none of A's decisions");

  // The Matching workspace is likewise isolated (B imported a PO but has no
  // ABs/decisions of A's).
  const aInbox = await runWithCompany(A, () => getMatching());
  const bInbox = await runWithCompany(B, () => getMatching());
  // Neither leaks the other's supplier into its rows/queue.
  const aBlob = JSON.stringify(aInbox);
  const bBlob = JSON.stringify(bInbox);
  assert.ok(!aBlob.includes("Beta AG"), "A never sees Beta");
  assert.ok(!bBlob.includes("Alpha GmbH"), "B never sees Alpha");
});

test("archival is per-tenant: A dropping a PO does not archive B's same PO", async () => {
  const A = "co-A2";
  const B = "co-B2";
  await runWithCompany(A, () => runImport([line("PO-SHARED", 10, "A")], "a1.csv", {}));
  await runWithCompany(B, () => runImport([line("PO-SHARED", 20, "B")], "b1.csv", {}));

  // A re-imports WITHOUT PO-SHARED → A archives it. B untouched.
  await runWithCompany(A, () => runImport([line("PO-OTHER", 10, "A")], "a2.csv", {}));

  const aShared = await runWithCompany(A, () => getActivePoLines("PO-SHARED"));
  const bShared = await runWithCompany(B, () => getActivePoLines("PO-SHARED"));
  assert.equal(aShared.length, 0, "A's PO-SHARED archived (not active)");
  assert.equal(bShared.length, 1, "B's PO-SHARED still active");
});
