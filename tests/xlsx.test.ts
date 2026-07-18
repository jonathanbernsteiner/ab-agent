import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { parseSapXlsx, buildExportXlsx } from "@/lib/sap/xlsx";
import { DEFAULT_MAPPING } from "@/lib/sap/mapping";
import type { ExportRow } from "@/lib/sap/export";

const DOT = { ...DEFAULT_MAPPING, decimal_sep: "." };

async function makeXlsx(headers: string[], rows: unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("POs");
  ws.addRow(headers);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

test("parseSapXlsx reads an Excel PO export (native numbers + dates)", async () => {
  // German-locale mapping: numeric cells (native numbers) must round-trip.
  const buf = await makeXlsx(
    ["Bestellnr", "Pos", "Material", "Menge", "Preis", "Wunschtermin"],
    [
      ["4500112901", 10, "GH-800", 800, 45.8, new Date(Date.UTC(2026, 6, 29))],
      ["4500112902", 20, "GH-900", 2400, 12.5, new Date(Date.UTC(2026, 7, 5))],
    ],
  );
  const parsed = await parseSapXlsx(buf, DEFAULT_MAPPING);
  assert.equal(parsed.rows.length, 2);
  const a = parsed.rows[0];
  assert.equal(a.po_number, "4500112901");
  assert.equal(a.position, 10);
  assert.equal(a.ordered_qty, 800);
  assert.equal(a.unit_price, 45.8, "native decimal survived locale round-trip");
  assert.equal(a.requested_date, "2026-07-29", "Excel date cell parsed to ISO");
  assert.equal(parsed.rows[1].unit_price, 12.5);
});

test("parseSapXlsx skips junk rows above the header like the CSV parser", async () => {
  const buf = await makeXlsx(
    ["Bestellungen Export", "", "", "", ""], // junk title row
    [
      ["Bestellnr", "Pos", "Menge", "Preis", "Wunschtermin"],
      ["4500112999", 10, 100, 9.99, "31.08.2026"],
    ],
  );
  const parsed = await parseSapXlsx(buf, DEFAULT_MAPPING);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].po_number, "4500112999");
  assert.equal(parsed.rows[0].unit_price, 9.99);
  assert.equal(parsed.rows[0].requested_date, "2026-08-31");
});

test("buildExportXlsx produces a workbook with the expected rows", async () => {
  const rows: ExportRow[] = [
    { po_number: "4500112873", position: 10, confirmed_date: "2026-07-24", confirmed_qty: 100, confirmed_price: 12.5, source: "auto" },
    { po_number: "4500112901", position: 10, confirmed_date: "2026-08-19", confirmed_qty: 800, confirmed_price: 47.2, source: "approved" },
  ];
  const buf = await buildExportXlsx(rows);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
  const ws = wb.worksheets[0];
  assert.equal(ws.getRow(1).getCell(1).value, "Bestellnr");
  assert.equal(ws.getRow(2).getCell(1).value, "4500112873");
  assert.equal(ws.getRow(2).getCell(3).value, "24.07.2026"); // German date
  assert.equal(ws.getRow(3).getCell(6).value, "Freigegeben");
  assert.equal(ws.getRow(2).getCell(6).value, "Auto");
});

test("DOT mapping: Excel native numbers still parse under dot-decimal locale", async () => {
  const buf = await makeXlsx(
    ["Bestellnr", "Pos", "Menge", "Preis"],
    [["4500113000", 10, 50, 8.0]],
  );
  const parsed = await parseSapXlsx(buf, DOT);
  assert.equal(parsed.rows[0].unit_price, 8);
  assert.equal(parsed.rows[0].ordered_qty, 50);
});
