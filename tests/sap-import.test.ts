import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSapCsv } from "@/lib/sap/import";
import { DEFAULT_MAPPING } from "@/lib/sap/mapping";
import { readFixtureBytes } from "./helpers/harness";
import { decodeCsv } from "@/lib/sap/import";

// The day1/day2 exports use English headers, a UTF-8 BOM, and DOT decimals —
// the exact opposite of the app's default German mapping (latin1 + comma).
// They must parse anyway via BOM/encoding + decimal-separator auto-detection,
// exactly as the app does with the default mapping.
test("day-1 export: parses all 34 PO lines with correct facts", () => {
  const text = decodeCsv(readFixtureBytes("po-exports/open_POs_export.csv"), DEFAULT_MAPPING.encoding);
  const { rows, headerLine, warnings, profile } = parseSapCsv(text, DEFAULT_MAPPING);

  assert.equal(headerLine, 0, "header is the first row");
  assert.equal(profile.decimal_sep, ".", "dot decimals auto-detected");
  assert.equal(profile.delimiter, ";");
  assert.equal(profile.columns.po_number, "PO_Number", "BOM stripped from first header");
  assert.deepEqual(warnings, []);
  assert.equal(rows.length, 34, "34 PO lines");

  // A representative clean line.
  const mt = rows.find((r) => r.po_number === "4500112873" && r.position === 10);
  assert.ok(mt, "found 4500112873/10");
  assert.equal(mt!.article, "MT-7734-A");
  assert.equal(mt!.ordered_qty, 2400);
  assert.equal(mt!.unit_price, 3.85, "dot decimal parsed, not 385");
  assert.equal(mt!.currency, "EUR");
  assert.equal(mt!.requested_date, "2026-07-24");
  assert.equal(mt!.po_date, "2026-07-06");
  assert.equal(mt!.supplier, "MetallTech Präzision GmbH", "umlaut survives");

  // The Hartmann PO line the AB will later match.
  const hart = rows.find((r) => r.po_number === "4500112901");
  assert.ok(hart);
  assert.equal(hart!.ordered_qty, 800);
  assert.equal(hart!.unit_price, 45.8);
  assert.equal(hart!.requested_date, "2026-07-29");

  // Confirmed lines carry their SAP confirmed date.
  const confirmed = rows.find((r) => r.po_number === "4500112940");
  assert.ok(confirmed);
  assert.equal(confirmed!.confirmed_date, "2026-07-20");
});

test("day-2 export: parses and includes the newly-added PO 4500112970", () => {
  const text = decodeCsv(readFixtureBytes("po-exports/open_POs_export_day2.csv"), DEFAULT_MAPPING.encoding);
  const { rows } = parseSapCsv(text, DEFAULT_MAPPING);
  assert.equal(rows.length, 6);

  // 4500112873 is now confirmed in SAP.
  const c1 = rows.find((r) => r.po_number === "4500112873" && r.position === 10);
  assert.equal(c1!.confirmed_date, "2026-07-24");

  const fresh = rows.find((r) => r.po_number === "4500112970");
  assert.ok(fresh, "new PO present");
  assert.equal(fresh!.po_date, "2026-07-07");
});

test("comma-delimited export: delimiter fallback finds the rows", () => {
  const text = [
    "PO_Number,Item,Material_No,Qty_Ordered,Price_EUR,Supplier",
    "4500000001,10,X-1,100,2.50,Acme GmbH",
    "4500000001,20,X-2,200,1.25,Acme GmbH",
  ].join("\n");
  const { rows, profile } = parseSapCsv(text, DEFAULT_MAPPING); // configured ";"
  assert.equal(rows.length, 2);
  assert.equal(profile.delimiter, ",");
  assert.equal(rows[0].unit_price, 2.5, "dot decimal detected despite comma delimiter");
});

test("real SAP export: skips junk header rows, handles German numbers + Latin-1", () => {
  // decode from raw bytes: file is Latin-1 encoded.
  const text = decodeCsv(readFixtureBytes("po-exports/sap_real_format.csv"));
  const { rows, headerLine, skippedJunk } = parseSapCsv(text, DEFAULT_MAPPING);

  assert.equal(skippedJunk, 2, "two junk metadata rows skipped");
  assert.equal(headerLine, 3, "header follows two metadata rows and a blank line");
  assert.ok(rows.length >= 2, "data rows extracted");

  const r = rows.find((x) => x.po_number === "4500112873" && x.position === 10);
  assert.ok(r, "found a real-format row");
  assert.equal(r!.ordered_qty, 2400, "thousands dot: 2.400 -> 2400");
  assert.equal(r!.unit_price, 3.85, "decimal comma: 3,85 -> 3.85");
  assert.match(r!.supplier ?? "", /Präzision/, "Latin-1 umlaut decoded");
});
