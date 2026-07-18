import Anthropic from "@anthropic-ai/sdk";
import "server-only";
import { config } from "@/lib/config";
import { parseDate, todayIso } from "@/lib/dates";
import type { Extraction, ExtractedPosition } from "@/lib/types";
import { EXTRACT_AB_TOOL, EXTRACTION_SYSTEM } from "./schema";

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: config.anthropic.apiKey() });
  return client;
}

export interface ExtractInput {
  pdfBase64?: string; // base64 PDF (no data: prefix, no newlines)
  bodyText?: string; // email body / plain text when there's no PDF
  filename?: string;
}

export interface ExtractOutput {
  extraction: Extraction;
  transcript: string;
  raw: unknown;
}

// Run the model over one document and return a normalized Extraction.
export async function extractDocument(input: ExtractInput): Promise<ExtractOutput> {
  const userContent: Anthropic.MessageParam["content"] = [];

  if (input.pdfBase64) {
    userContent.push({
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: input.pdfBase64,
      },
    });
    userContent.push({
      type: "text",
      text: "Lies diese Auftragsbestätigung und rufe extract_ab auf.",
    });
  } else {
    userContent.push({
      type: "text",
      text:
        "Der folgende Text ist der Inhalt einer E-Mail (ohne PDF-Anhang). Behandle ihn als mögliche Auftragsbestätigung und rufe extract_ab auf:\n\n" +
        (input.bodyText ?? ""),
    });
  }

  let response: Anthropic.Message;
  try {
    response = await anthropic().messages.create({
      model: config.anthropic.model(),
      max_tokens: 4096,
      thinking: { type: "disabled" },
      system: EXTRACTION_SYSTEM,
      tools: [EXTRACT_AB_TOOL],
      tool_choice: { type: "tool", name: "extract_ab" },
      messages: [{ role: "user", content: userContent }],
    });
  } catch (err) {
    // A 400 on a document upload means the API couldn't read the PDF (corrupt,
    // truncated, encrypted, or not really a PDF). Turn the raw API error into a
    // friendly, non-leaky message the clerk can act on.
    if (err instanceof Anthropic.APIError && err.status === 400 && input.pdfBase64) {
      throw new Error(
        "Das Dokument konnte nicht gelesen werden — bitte eine gültige, nicht beschädigte oder passwortgeschützte PDF-Datei hochladen.",
      );
    }
    throw err;
  }

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
  );
  if (!toolUse) {
    throw new Error("Model did not return an extract_ab tool call.");
  }

  const raw = toolUse.input as Record<string, unknown>;
  return {
    extraction: normalize(raw),
    transcript: typeof raw.transcript === "string" ? raw.transcript : "",
    raw,
  };
}

// Rebuild an Extraction from a stored raw tool output (extractions.raw_output).
// Deterministic, no model call — used to auto-rematch an AB when its PO is
// imported later.
export function extractionFromRaw(raw: unknown): Extraction {
  return normalize((raw ?? {}) as Record<string, unknown>);
}

// Normalize model output into our Extraction type, hardening dates (ISO, KW).
function normalize(raw: Record<string, unknown>): Extraction {
  const refYear = parseInt(todayIso().slice(0, 4), 10);

  const rawPositions = Array.isArray(raw.positions) ? raw.positions : [];
  const positions: ExtractedPosition[] = rawPositions.map((p) => {
    const pos = (p ?? {}) as Record<string, unknown>;
    const partialsRaw = Array.isArray(pos.partial_deliveries) ? pos.partial_deliveries : [];
    return {
      position: numOrNull(pos.position),
      article: strOrNull(pos.article),
      description: strOrNull(pos.description),
      quantity: numOrNull(pos.quantity),
      unit_price: numOrNull(pos.unit_price),
      currency: strOrNull(pos.currency),
      confirmed_delivery_date:
        parseDate(strOrNull(pos.confirmed_delivery_date), refYear) ??
        parseDate(strOrNull(pos.delivery_date_note), refYear),
      delivery_date_note: strOrNull(pos.delivery_date_note),
      partial_deliveries: partialsRaw.map((pd) => {
        const part = (pd ?? {}) as Record<string, unknown>;
        return {
          quantity: numOrNull(part.quantity) ?? 0,
          delivery_date:
            parseDate(strOrNull(part.delivery_date), refYear) ??
            parseDate(strOrNull(part.delivery_date_note), refYear),
          delivery_date_note: strOrNull(part.delivery_date_note),
        };
      }),
      notes: strOrNull(pos.notes),
    };
  });

  return {
    is_order_confirmation: raw.is_order_confirmation === true,
    language: (strOrNull(raw.language) as Extraction["language"]) ?? null,
    ab_number: strOrNull(raw.ab_number),
    supplier: strOrNull(raw.supplier),
    po_number: normalizePoNumber(strOrNull(raw.po_number)),
    po_number_context: strOrNull(raw.po_number_context),
    positions,
    global_notes: Array.isArray(raw.global_notes)
      ? raw.global_notes.filter((n): n is string => typeof n === "string")
      : [],
    confidence: (strOrNull(raw.confidence) as Extraction["confidence"]) ?? "medium",
  };
}

function normalizePoNumber(po: string | null): string | null {
  if (!po) return null;
  const digits = po.match(/\d[\d\s-]{4,}\d/);
  return (digits ? digits[0] : po).replace(/[\s-]/g, "").trim() || null;
}

function strOrNull(v: unknown): string | null {
  if (typeof v === "string") {
    const t = v.trim();
    return t.length ? t : null;
  }
  return null;
}

function numOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
