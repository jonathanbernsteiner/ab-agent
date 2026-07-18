import "server-only";
import { extractDocument } from "@/lib/extraction/extract";
import { matchAb } from "@/lib/matching";
import { config } from "@/lib/config";
import { sha256Hex, normalizeForHash } from "@/lib/hash";
import { storeDocument } from "@/lib/supabase";
import { getSupabase } from "@/lib/supabase";
import { getCompanyId } from "@/lib/tenant";
import {
  confirmedPositions,
  findAbByHash,
  getActivePoLines,
  persistAb,
  recomputePo,
} from "@/lib/store";
import { displayNameOf, emailAddressOf, learnContact } from "@/lib/contacts";
import type { MatchResult } from "@/lib/types";

export interface IngestInput {
  bytes?: Uint8Array; // original file bytes (PDF)
  bodyText?: string; // email body when there's no PDF
  filename?: string | null;
  mimeType?: string | null;
  source: "upload" | "email";
  sourceMeta?: Record<string, unknown>;
}

export interface IngestResult {
  deduped: boolean;
  abId: string;
  docKind: "ab" | "not_ab" | "unknown";
  bucket: MatchResult["overall_bucket"] | null;
  poNumber: string | null;
  supplier: string | null;
  abNumber: string | null;
  match: MatchResult | null;
  message: string;
}

export async function ingestDocument(input: IngestInput): Promise<IngestResult> {
  const isPdf =
    !!input.bytes &&
    (input.mimeType === "application/pdf" ||
      (input.filename ?? "").toLowerCase().endsWith(".pdf"));

  // 1) Dedupe key — bytes for files, normalized text for email bodies.
  const contentHash = input.bytes
    ? sha256Hex(input.bytes)
    : sha256Hex(normalizeForHash(input.bodyText ?? ""));

  const existing = await findAbByHash(contentHash);
  if (existing) {
    return {
      deduped: true,
      abId: existing.id,
      docKind: existing.doc_kind as IngestResult["docKind"],
      bucket: null,
      poNumber: existing.po_number,
      supplier: existing.supplier,
      abNumber: existing.ab_number,
      match: null,
      message: "Dieses Dokument wurde bereits verarbeitet (Duplikat).",
    };
  }

  // 2) Store the original, if we have bytes. Paths are prefixed by company so
  // tenants never collide and a reset can purge just this company's objects.
  let storagePath: string | null = null;
  if (input.bytes) {
    const safe = (input.filename ?? "dokument.pdf").replace(/[^\w.\-]+/g, "_");
    storagePath = `${getCompanyId()}/${contentHash.slice(0, 12)}-${safe}`;
    try {
      await storeDocument(
        storagePath,
        input.bytes,
        input.mimeType ?? "application/pdf",
      );
    } catch {
      storagePath = null; // storage is best-effort; extraction still proceeds
    }
  }

  // 3) Extract.
  const { extraction, transcript, raw } = await extractDocument({
    pdfBase64: isPdf ? Buffer.from(input.bytes!).toString("base64") : undefined,
    bodyText: !isPdf
      ? input.bodyText ?? (input.bytes ? bytesToText(input.bytes) : "")
      : undefined,
    filename: input.filename ?? undefined,
  });

  // 4) Classify + match.
  const isAb = extraction.is_order_confirmation && !!extraction.po_number;
  const docKind: IngestResult["docKind"] = isAb ? "ab" : "not_ab";

  let match: MatchResult | null = null;
  let bucket: MatchResult["overall_bucket"] | null = null;
  if (isAb) {
    const poLines = await getActivePoLines(extraction.po_number!);
    match = matchAb(extraction, poLines, confirmedPositions(poLines));
    bucket = match.overall_bucket;
  }

  // 5) Persist everything (nothing is ever deleted).
  let abId: string;
  try {
    abId = await persistAb({
      contentHash,
      source: input.source,
      sourceMeta: input.sourceMeta,
      storagePath,
      originalFilename: input.filename ?? null,
      mimeType: input.mimeType ?? null,
      abNumber: extraction.ab_number,
      supplier: extraction.supplier,
      poNumber: extraction.po_number,
      docKind,
      model: config.anthropic.model(),
      rawOutput: raw,
      transcript,
      match,
    });
  } catch (err) {
    // Lost a dedupe race: a concurrent ingest of the identical document inserted
    // the abs row first (content_hash is unique). The abs insert is the first
    // write in persistAb, so this path leaves no extraction/match orphans — fall
    // back to the winner's record instead of surfacing a 500.
    if (isUniqueViolation(err)) {
      const winner = await findAbByHash(contentHash);
      if (winner) {
        return {
          deduped: true,
          abId: winner.id,
          docKind: winner.doc_kind as IngestResult["docKind"],
          bucket: null,
          poNumber: winner.po_number,
          supplier: winner.supplier,
          abNumber: winner.ab_number,
          match: null,
          message: "Dieses Dokument wurde bereits verarbeitet (Duplikat).",
        };
      }
    }
    throw err;
  }

  // 6) A confirmation that arrived by email tells us who to write at this
  //    supplier — remember the sender so chasers/pushbacks have an address.
  if (isAb && input.source === "email" && extraction.supplier) {
    const from = (input.sourceMeta as { from?: string } | undefined)?.from;
    await learnContact({
      supplier: extraction.supplier,
      email: emailAddressOf(from),
      name: displayNameOf(from),
      source: "inbound",
    });
  }

  // 7) A reply/AB that resolves an overdue PO closes its chaser automatically
  //    and folds its confirmations onto the spine (status + promoted fields).
  if (isAb && extraction.po_number && bucket !== "no_po") {
    await closeChasersForPo(extraction.po_number);
    await recomputePo(extraction.po_number);
  }

  return {
    deduped: false,
    abId,
    docKind,
    bucket,
    poNumber: extraction.po_number,
    supplier: extraction.supplier,
    abNumber: extraction.ab_number,
    match,
    message: buildMessage(docKind, bucket, extraction.po_number),
  };
}

function buildMessage(
  docKind: IngestResult["docKind"],
  bucket: MatchResult["overall_bucket"] | null,
  poNumber: string | null,
): string {
  if (docKind === "not_ab") {
    return "Keine Bestellnummer gefunden — ist das eine Auftragsbestätigung? Das Dokument wurde abgelegt, aber keiner Bestellung zugeordnet.";
  }
  if (bucket === "no_po") {
    return `Auftragsbestätigung erkannt (Bestellung ${poNumber}), aber diese Bestellung ist nicht in der aktuellen SAP-Liste. Bitte SAP-Export prüfen.`;
  }
  if (bucket === "match") {
    return `Alles passt — Bestellung ${poNumber} bestätigt und für den Abendexport vorgemerkt.`;
  }
  if (bucket === "deviation") {
    return `Abweichung(en) gefunden für Bestellung ${poNumber} — bitte prüfen.`;
  }
  return "Verarbeitet.";
}

async function closeChasersForPo(poNumber: string): Promise<void> {
  const sb = getSupabase();
  const { data } = await sb
    .from("chasers")
    .select("id, history, status")
    .eq("company_id", getCompanyId())
    .eq("po_number", poNumber)
    .neq("status", "resolved");
  for (const c of data ?? []) {
    const history = Array.isArray(c.history) ? c.history : [];
    await sb
      .from("chasers")
      .update({
        status: "resolved",
        history: [
          ...history,
          { at: new Date().toISOString(), action: "auto_resolved_ab_received" },
        ],
        updated_at: new Date().toISOString(),
      })
      .eq("id", c.id);
  }
}

// Postgres unique-violation (SQLSTATE 23505), as surfaced by supabase-js.
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (code === "23505") return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" && message.includes("duplicate key");
}

function bytesToText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return "";
  }
}
