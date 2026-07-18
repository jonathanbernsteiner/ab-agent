import { parseDate } from "@/lib/dates";
import type { PoLine } from "@/lib/types";
import {
  DEFAULT_MAPPING,
  HEADER_SYNONYMS,
  type ColumnMapping,
  type LogicalField,
} from "./mapping";

// What the parser detected about the file — shown to the user in the import
// preview so they can confirm the file was understood before importing.
export interface ImportProfile {
  delimiter: string | null; // null for Excel (no delimiter concept)
  decimal_sep: string;
  // logical field -> the exact header text it matched, or null if absent
  columns: Record<LogicalField, string | null>;
}

export interface ParsedImport {
  rows: PoLine[];
  headerLine: number; // index of the detected header row
  skippedJunk: number; // junk rows skipped before the header
  warnings: string[];
  profile: ImportProfile;
}

export function emptyProfile(mapping: ColumnMapping): ImportProfile {
  const columns = {} as Record<LogicalField, string | null>;
  (Object.keys(mapping.mapping) as LogicalField[]).forEach((f) => (columns[f] = null));
  return { delimiter: null, decimal_sep: mapping.decimal_sep, columns };
}

// Sniff the real encoding: a UTF-8 BOM wins over any configured encoding
// (a latin1 decode would turn it into "ï»¿" and break the first header).
export function sniffEncoding(
  bytes: Uint8Array,
  configured?: "utf-8" | "latin1",
): "utf-8" | "latin1" {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return "utf-8";
  }
  if (configured === "latin1") return "latin1";
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  return utf8.includes("�") ? "latin1" : "utf-8";
}

// Decode raw bytes. SAP exports are frequently Latin-1; if a UTF-8 decode hits
// the replacement char we fall back to Latin-1 so umlauts survive.
export function decodeCsv(bytes: Uint8Array, encoding?: "utf-8" | "latin1"): string {
  const text = new TextDecoder(sniffEncoding(bytes, encoding)).decode(bytes);
  return text.replace(/^\uFEFF/, "");
}

// Split a single CSV line honouring double-quoted fields.
function splitLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

// German number: decimal comma, dot thousands separator. "1.234,56" -> 1234.56.
// SAP encodes negatives (credits, returns) with a TRAILING minus — "45,80-" —
// so the sign is detected separately and reapplied; otherwise `Number("45.80-")`
// is NaN and the value would be silently dropped.
export function parseGermanNumber(raw: string, decimalSep = ","): number | null {
  const s = raw.trim();
  if (!s) return null;
  const negative = /^\s*-/.test(s) || /-\s*$/.test(s);
  let normalized = s;
  if (decimalSep === ",") {
    normalized = normalized.replace(/\./g, "").replace(",", ".");
  }
  normalized = normalized.replace(/[^\d.]/g, ""); // strip signs, currency, units
  if (!normalized || normalized === ".") return null;
  const n = Number(normalized);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

function norm(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, "");
}

// Resolve each logical field to a column index using the mapping, then falling
// back to synonyms. Returns -1 for a field that isn't present.
function resolveColumns(
  headers: string[],
  mapping: ColumnMapping,
): Record<LogicalField, number> {
  const normalized = headers.map(norm);
  const result = {} as Record<LogicalField, number>;
  (Object.keys(mapping.mapping) as LogicalField[]).forEach((field) => {
    const target = norm(mapping.mapping[field]);
    let idx = normalized.indexOf(target);
    if (idx === -1) {
      for (const syn of HEADER_SYNONYMS[field]) {
        idx = normalized.indexOf(norm(syn));
        if (idx !== -1) break;
      }
    }
    result[field] = idx;
  });
  return result;
}

// Score a candidate header row by how many logical fields it resolves.
function scoreHeaderRow(headers: string[], mapping: ColumnMapping): number {
  const cols = resolveColumns(headers, mapping);
  return Object.values(cols).filter((i) => i >= 0).length;
}

// Vote on the actual decimal separator using the qty/price cells, so an
// English export ("3.85") configured for decimal-comma doesn't parse as 385.
// A lone separator followed by exactly 3-digit groups is a thousands
// separator ("2.400", "1,234") and casts no vote.
function detectDecimalSep(values: string[], configured: string): string {
  let dot = 0;
  let comma = 0;
  for (const raw of values) {
    const s = raw.trim();
    const lastDot = s.lastIndexOf(".");
    const lastComma = s.lastIndexOf(",");
    if (lastDot === -1 && lastComma === -1) continue;
    if (lastDot !== -1 && lastComma !== -1) {
      if (lastDot > lastComma) dot++;
      else comma++;
    } else if (lastDot !== -1) {
      if (!/^\d{1,3}(\.\d{3})+$/.test(s)) dot++;
    } else {
      if (!/^\d{1,3}(,\d{3})+$/.test(s)) comma++;
    }
  }
  if (dot > comma) return ".";
  if (comma > dot) return ",";
  return configured;
}

// Parse a CSV export by splitting it into a grid of cells, then running the
// shared row parser. Excel imports feed the same parser via parseSapGrid().
// If the configured delimiter yields nothing, common alternatives are tried
// so a comma- or tab-delimited export still imports.
export function parseSapCsv(
  text: string,
  mapping: ColumnMapping = DEFAULT_MAPPING,
): ParsedImport {
  const candidates = [...new Set([mapping.delimiter, ";", ",", "\t"])];
  let best: ParsedImport | null = null;
  let bestDelimiter = mapping.delimiter;
  for (const delimiter of candidates) {
    const grid = text
      .split(/\r?\n/)
      .map((line) => (line.trim() ? splitLine(line, delimiter) : []));
    const parsed = parseSapGrid(grid, mapping);
    if (!best || parsed.rows.length > best.rows.length) {
      best = parsed;
      bestDelimiter = delimiter;
    }
    if (parsed.rows.length > 0 && delimiter === mapping.delimiter) break;
  }
  best!.profile.delimiter = bestDelimiter;
  return best!;
}

// The shared SAP parser: a grid of string cells → PoLine[]. Both CSV and XLSX
// resolve to this, so header detection, junk skipping, German number/date
// hardening, and duplicate collapsing behave identically for either format.
export function parseSapGrid(
  grid: string[][],
  mapping: ColumnMapping = DEFAULT_MAPPING,
): ParsedImport {
  const warnings: string[] = [];
  const nonEmpty = (row: string[]) => row.some((c) => c && c.trim());

  // Find the header row: the row that resolves the most logical columns.
  let headerIdx = -1;
  let bestScore = 0;
  for (let i = 0; i < grid.length; i++) {
    const fields = grid[i];
    if (!fields || fields.length < 2 || !nonEmpty(fields)) continue;
    const score = scoreHeaderRow(fields, mapping);
    if (score > bestScore) {
      bestScore = score;
      headerIdx = i;
    }
    if (score >= 4) break;
  }

  if (headerIdx === -1 || bestScore < 2) {
    return {
      rows: [],
      headerLine: -1,
      skippedJunk: 0,
      warnings: [
        "Keine gültige Kopfzeile gefunden. Bitte Spaltenzuordnung in den Einstellungen prüfen.",
      ],
      profile: emptyProfile(mapping),
    };
  }

  const cols = resolveColumns(grid[headerIdx], mapping);
  const skippedJunk = grid.slice(0, headerIdx).filter(nonEmpty).length;

  const profile = emptyProfile(mapping);
  (Object.keys(cols) as LogicalField[]).forEach((f) => {
    profile.columns[f] = cols[f] >= 0 ? (grid[headerIdx][cols[f]] ?? "").trim() : null;
  });

  // Without a PO-number and position column, no line can be keyed. Fail with a
  // diagnostic that names the missing column instead of a vague "no data rows".
  if (cols.po_number < 0 || cols.position < 0) {
    const missing = [
      cols.po_number < 0 ? "Bestellnummer" : null,
      cols.position < 0 ? "Position" : null,
    ].filter(Boolean).join(" und ");
    return {
      rows: [],
      headerLine: headerIdx,
      skippedJunk,
      warnings: [
        `Pflichtspalte ${missing} nicht gefunden. Bitte Spaltenzuordnung in den Einstellungen prüfen.`,
      ],
      profile,
    };
  }

  const cell = (fields: string[], field: LogicalField): string => {
    const idx = cols[field];
    if (idx < 0 || idx >= fields.length) return "";
    return fields[idx] ?? "";
  };

  // Decide the effective decimal separator from the numeric cells themselves.
  const numericSamples: string[] = [];
  for (let i = headerIdx + 1; i < grid.length; i++) {
    const fields = grid[i];
    if (!fields || !nonEmpty(fields)) continue;
    for (const f of ["ordered_qty", "unit_price"] as const) {
      const v = cell(fields, f).trim();
      if (v) numericSamples.push(v);
    }
  }
  const decimalSep = detectDecimalSep(numericSamples, mapping.decimal_sep);
  profile.decimal_sep = decimalSep;

  const rows: PoLine[] = [];
  for (let i = headerIdx + 1; i < grid.length; i++) {
    const fields = grid[i];
    if (!fields || !nonEmpty(fields)) continue;
    const poNumber = cell(fields, "po_number").trim();
    const positionRaw = cell(fields, "position").trim();
    // Skip footer/summary junk: a PO line has a digit-bearing PO number and a
    // purely-numeric position (e.g. "Summe / 5 Positionen" is not a line).
    if (!poNumber || !/\d/.test(poNumber)) continue;
    if (!/^\d+$/.test(positionRaw)) continue;

    const position = parseInt(positionRaw, 10);
    if (!Number.isFinite(position)) continue;

    rows.push({
      po_number: poNumber,
      position,
      article: cell(fields, "article") || null,
      article_desc: cell(fields, "article_desc") || null,
      ordered_qty: parseGermanNumber(cell(fields, "ordered_qty"), decimalSep),
      unit_price: parseGermanNumber(cell(fields, "unit_price"), decimalSep),
      currency: (cell(fields, "currency") || "EUR").toUpperCase(),
      requested_date: parseDate(cell(fields, "requested_date")),
      po_date: parseDate(cell(fields, "po_date")),
      supplier: cell(fields, "supplier") || null,
      confirmed_date: parseDate(cell(fields, "confirmed_date")),
    });
  }

  // Collapse duplicate (po_number, position) lines — the last wins, mirroring the
  // store's upsert — and tell the user rather than silently double-counting.
  const byKey = new Map<string, PoLine>();
  for (const r of rows) byKey.set(`${r.po_number}|${r.position}`, r);
  const deduped = [...byKey.values()];
  if (deduped.length < rows.length) {
    warnings.push(
      `${rows.length - deduped.length} doppelte Zeile(n) (gleiche Bestellnr + Position) — jeweils die letzte wurde übernommen.`,
    );
  }

  if (deduped.length === 0) {
    warnings.push("Kopfzeile erkannt, aber keine Datenzeilen gefunden.");
  }
  return { rows: deduped, headerLine: headerIdx, skippedJunk, warnings, profile };
}
