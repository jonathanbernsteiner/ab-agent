import ExcelJS from "exceljs";
import { formatDe } from "@/lib/dates";
import { emptyProfile, parseSapGrid, type ParsedImport } from "./import";
import { DEFAULT_MAPPING, type ColumnMapping } from "./mapping";
import type { ExportRow } from "./export";

// ── Import: .xlsx → the same grid the CSV parser consumes ───────────────────
// Numeric cells are re-formatted into the mapping's locale (e.g. "45,80") and
// date cells to ISO, so the shared parseSapGrid() applies the identical German
// number / date hardening for either file format.
export async function parseSapXlsx(
  buffer: ArrayBuffer | Buffer | Uint8Array,
  mapping: ColumnMapping = DEFAULT_MAPPING,
): Promise<ParsedImport> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as Parameters<typeof wb.xlsx.load>[0]);
  const ws = wb.worksheets[0];
  if (!ws) {
    return { rows: [], headerLine: -1, skippedJunk: 0, warnings: ["Keine Tabelle in der Excel-Datei gefunden."], profile: emptyProfile(mapping) };
  }

  const grid: string[][] = [];
  ws.eachRow({ includeEmpty: true }, (row) => {
    const values = row.values as unknown[]; // 1-indexed; [empty, c1, c2, …]
    const cells: string[] = [];
    for (let i = 1; i < values.length; i++) cells.push(cellToString(values[i], mapping));
    grid.push(cells);
  });

  return parseSapGrid(grid, mapping);
}

function cellToString(v: unknown, mapping: ColumnMapping): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return String(v).replace(".", mapping.decimal_sep);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as { result?: unknown; text?: unknown; richText?: { text: string }[]; hyperlink?: string };
    if (o.result != null) return cellToString(o.result, mapping); // formula
    if (Array.isArray(o.richText)) return o.richText.map((r) => r.text).join("");
    if (o.text != null) return String(o.text);
    return "";
  }
  return String(v);
}

// ── Export: the evening confirmations as a real .xlsx workbook ──────────────
export async function buildExportXlsx(rows: ExportRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "ab-agent";
  const ws = wb.addWorksheet("Bestätigungen");
  ws.columns = [
    { header: "Bestellnr", key: "po", width: 16 },
    { header: "Pos", key: "pos", width: 8 },
    { header: "Bestaetigt", key: "date", width: 14 },
    { header: "Menge", key: "qty", width: 12 },
    { header: "Preis", key: "price", width: 12 },
    { header: "Quelle", key: "source", width: 14 },
  ];
  ws.getRow(1).font = { bold: true };
  for (const r of rows) {
    ws.addRow({
      po: r.po_number,
      pos: r.position,
      date: formatDe(r.confirmed_date),
      qty: r.confirmed_qty ?? null,
      price: r.confirmed_price ?? null,
      source: r.source === "auto" ? "Auto" : "Freigegeben",
    });
  }
  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}
