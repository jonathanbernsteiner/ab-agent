import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ingestDocument } from "@/lib/pipeline";
import { runImport } from "@/lib/store";
import { decodeCsv, parseSapCsv } from "@/lib/sap/import";
import { DEFAULT_MAPPING } from "@/lib/sap/mapping";
import {
  installFakeDb,
  readFixtureBytes,
  readFixtureText,
  readFixtureJson,
  hasAnthropicKey,
} from "./helpers/harness";
import type { FindingType } from "@/lib/types";

// These tests run the REAL extraction pipeline (Claude reads the actual PDFs /
// email). They require ANTHROPIC_API_KEY and are skipped — with a clear note —
// when no key is present. Nothing here is hardcoded: assertions check the live
// model's read against fixtures/expected/*.json.
const skip = hasAnthropicKey ? false : "no ANTHROPIC_API_KEY set — model tests skipped";

const DOT_MAPPING = { ...DEFAULT_MAPPING, decimal_sep: "." };

before(() => {
  if (!hasAnthropicKey) {
    console.log(
      "\n[pipeline.model] SKIPPED: set ANTHROPIC_API_KEY to run the real extraction tests " +
        "(Hartmann findings, FedernVogel prose PO#, email KW32, dedupe, garbage rejection).\n",
    );
  }
});

async function seedDay1() {
  const { rows } = parseSapCsv(decodeCsv(readFixtureBytes("po-exports/open_POs_export.csv")), DOT_MAPPING);
  await runImport(rows, "open_POs_export.csv", DOT_MAPPING);
}

beforeEach(async () => {
  installFakeDb();
  if (hasAnthropicKey) await seedDay1();
});

function pdf(rel: string) {
  return {
    bytes: readFixtureBytes(rel),
    mimeType: "application/pdf",
    filename: rel.split("/").pop()!,
    source: "upload" as const,
  };
}

test("Hartmann AB: all three deviations detected, incl. the prose price change", { skip }, async () => {
  const expected = readFixtureJson<{ po_number: string; expected_bucket: string }>(
    "expected/hartmann_findings.json",
  );
  const r = await ingestDocument(pdf("abs/AB_GusswerkHartmann_4500112901.pdf"));

  assert.equal(r.docKind, "ab");
  assert.equal(r.poNumber, expected.po_number);
  assert.equal(r.bucket, "deviation");

  const found = new Set<FindingType>(r.match!.positions.flatMap((p) => p.findings.map((f) => f.type)));
  assert.ok(found.has("date_later"), "later delivery detected");
  assert.ok(found.has("partial_split"), "partial split detected");
  assert.ok(found.has("price_increase"), "PROSE price increase detected (the hard one)");
});

test("MetallTech AB: clean corporate layout is a perfect match", { skip }, async () => {
  const r = await ingestDocument(pdf("abs/AB_MetallTech_4500112873.pdf"));
  assert.equal(r.docKind, "ab");
  assert.equal(r.poNumber, "4500112873");
  assert.equal(r.bucket, "match");
});

test("FedernVogel AB: PO number buried in typewriter prose is still matched", { skip }, async () => {
  const r = await ingestDocument(pdf("abs/AB_FedernVogel_4500112944.pdf"));
  assert.equal(r.docKind, "ab");
  assert.equal(r.poNumber, "4500112944");
  assert.notEqual(r.bucket, "no_po", "PO resolved from prose");
});

test("email-body AB (no attachment): matches 4500112956 and resolves via KW 32", { skip }, async () => {
  const expected = readFixtureJson<{ po_number: string }>("expected/email_body_expected.json");
  const body = readFixtureText("emails/email_body_only_confirmation.txt");
  const r = await ingestDocument({ bodyText: body, source: "email", filename: "email.txt" });

  assert.equal(r.docKind, "ab");
  assert.equal(r.poNumber, expected.po_number);
  // Requested 07.08.2026 falls in KW 32 -> delivery treated as met.
  assert.equal(r.bucket, "match");
});

test("forwarded Postmark webhook: same result as upload, and a re-POST dedupes", { skip }, async () => {
  const payload = readFixtureJson<{
    Attachments: { Name: string; ContentType: string; Content: string }[];
    From: string;
    Subject: string;
  }>("emails/email_forwarded_with_pdf.json");
  const att = payload.Attachments[0];
  const input = {
    bytes: new Uint8Array(Buffer.from(att.Content, "base64")),
    mimeType: att.ContentType,
    filename: att.Name,
    source: "email" as const,
    sourceMeta: { from: payload.From, subject: payload.Subject },
  };

  const first = await ingestDocument(input);
  assert.equal(first.deduped, false);
  assert.equal(first.docKind, "ab");
  assert.equal(first.poNumber, "4500112873");

  const second = await ingestDocument(input);
  assert.equal(second.deduped, true, "identical attachment is not processed twice");
  assert.equal(second.abId, first.abId);
});

test("garbage invoice PDF lands in a friendly not-an-AB state (no crash, no match)", { skip }, async () => {
  const r = await ingestDocument(pdf("garbage/random_invoice.pdf"));
  assert.equal(r.docKind, "not_ab");
  assert.equal(r.bucket, null);
  assert.equal(r.match, null);
});
