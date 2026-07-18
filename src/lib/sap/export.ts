import { formatDe } from "@/lib/dates";

export interface ExportRow {
  po_number: string;
  position: number;
  confirmed_date: string | null; // ISO
  confirmed_qty?: number | null;
  confirmed_price?: number | null;
  source: "auto" | "approved"; // auto-matched vs human-approved deviation
}

function germanNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return "";
  return n.toFixed(2).replace(".", ",");
}

// SAP mass-import CSV: semicolon-separated, German dates (dd.mm.yyyy), decimal
// comma, one row per PO position. UTF-8 with a BOM so Excel opens umlauts right.
export function buildExportCsv(rows: ExportRow[]): string {
  const header = [
    "Bestellnr",
    "Pos",
    "Bestaetigt",
    "Menge",
    "Preis",
    "Quelle",
  ].join(";");

  const body = rows.map((r) =>
    [
      r.po_number,
      String(r.position),
      formatDe(r.confirmed_date),
      germanNumber(r.confirmed_qty),
      germanNumber(r.confirmed_price),
      r.source === "auto" ? "Auto" : "Freigegeben",
    ].join(";"),
  );

  return "﻿" + [header, ...body].join("\r\n") + "\r\n";
}
