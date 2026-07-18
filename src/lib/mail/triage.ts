import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { config } from "@/lib/config";
import type { MailMessage, TriageMode, TriageResult } from "./types";

// Two-stage gate that decides whether a message is worth the (expensive) Opus
// extraction pipeline. In `scanned` mode the loop reads the WHOLE mailbox, so
// most mail is noise — we must reject it cheaply:
//
//   1. prefilter()  — free, deterministic. Kills obvious non-ABs (no PDF, no PO
//                     number, no AB vocabulary) at zero token cost.
//   2. classify()   — the cheap classifier model (Haiku), a single yes/no, only
//                     for messages the prefilter let through.
//
// In `forwarded` mode a human already chose to forward the mail, so we skip both
// gates and ingest — identical to today's webhook behavior, just logged.

// ── Deterministic prefilter (free) ──────────────────────────────────────────

// SAP purchase orders here are 10-digit numbers starting 45… (4500112873 etc.).
const PO_NUMBER = /\b45\d{8}\b/;

// Order-confirmation vocabulary (DE + EN). Presence is a strong "maybe".
const AB_TERMS = [
  "auftragsbestätigung",
  "auftragsbestatigung",
  "auftragsbest",
  "bestellbestätigung",
  "order confirmation",
  "confirmation of order",
  "ihre bestellung",
  "zu ihrer bestellung",
  "bestellnummer",
  "purchase order",
  "po number",
  "liefertermin",
  "confirmed delivery",
];

function hasPdf(msg: MailMessage): boolean {
  return msg.attachments.some(
    (a) =>
      a.contentType.toLowerCase().includes("pdf") ||
      a.filename.toLowerCase().endsWith(".pdf"),
  );
}

export interface PrefilterResult {
  pass: boolean; // true = plausibly an AB, worth the classifier/pipeline
  reason: string;
}

// Cheap signals only. Deliberately biased toward recall (pass): a false "maybe"
// costs one Haiku call; a false "skip" silently drops a real AB, which is the
// failure we care about. When in doubt, pass.
export function prefilter(msg: MailMessage): PrefilterResult {
  const haystack = [msg.subject ?? "", msg.text ?? ""].join("\n").toLowerCase();

  if (hasPdf(msg)) return { pass: true, reason: "PDF attachment present" };
  if (PO_NUMBER.test(haystack)) return { pass: true, reason: "PO number (45…) found in text" };
  const term = AB_TERMS.find((t) => haystack.includes(t));
  if (term) return { pass: true, reason: `order-confirmation term “${term}”` };

  // No attachment, no PO number, no AB vocabulary → almost certainly not an AB.
  if (!haystack.trim()) return { pass: false, reason: "empty message" };
  return { pass: false, reason: "no PDF, PO number, or confirmation vocabulary" };
}

// ── Cheap-model classifier (Haiku) ──────────────────────────────────────────

const CLASSIFY_TOOL = {
  name: "classify_message",
  description:
    "Record whether this email is a supplier ORDER CONFIRMATION (Auftragsbestätigung / AB) that references a purchase order.",
  input_schema: {
    type: "object" as const,
    properties: {
      is_order_confirmation: {
        type: "boolean",
        description:
          "True only if the email (or its described attachment) is a supplier order confirmation referring to a purchase order. False for invoices, delivery notes, quotes, marketing, newsletters, internal mail, or anything unrelated.",
      },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      reason: {
        type: "string",
        description: "One short phrase explaining the decision.",
      },
    },
    required: ["is_order_confirmation", "confidence", "reason"],
    additionalProperties: false,
  },
};

const CLASSIFY_SYSTEM = `Du bist ein Klassifikator im Einkauf. Entscheide für eine einzelne E-Mail, ob es sich um eine Auftragsbestätigung (AB) eines Lieferanten handelt, die sich auf eine Bestellung bezieht.

- Rufe das Tool "classify_message" GENAU EINMAL auf. Antworte mit nichts anderem.
- true NUR bei einer Auftragsbestätigung / Order Confirmation zu einer Bestellung.
- false bei Rechnungen, Lieferscheinen, Angeboten, Werbung, Newslettern, internen Mails, Autorespondern oder Unklarem.
- Im Zweifel: lieber true mit niedriger confidence, damit nichts verloren geht (ein Mensch prüft danach).`;

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: config.anthropic.apiKey() });
  return client;
}

export interface ClassifyResult {
  isConfirmation: boolean;
  confidence: "high" | "medium" | "low";
  reason: string;
}

// Test seam: inject a deterministic classifier so the scanned-mode loop is
// testable offline (no key, no network), mirroring __setTestSupabaseClient.
type Classifier = (msg: MailMessage) => Promise<ClassifyResult>;
let testClassifier: Classifier | null = null;
export function __setTestClassifier(fn: Classifier | null): void {
  testClassifier = fn;
}

export async function classify(msg: MailMessage): Promise<ClassifyResult> {
  if (testClassifier) return testClassifier(msg);

  const attachmentNote = msg.attachments.length
    ? `\n\n[Anhänge: ${msg.attachments.map((a) => a.filename).join(", ")}]`
    : "";
  const body = [
    msg.from ? `Von: ${msg.from}` : "",
    msg.subject ? `Betreff: ${msg.subject}` : "",
    "",
    msg.text ?? "(kein Textkörper)",
    attachmentNote,
  ]
    .filter(Boolean)
    .join("\n");

  const response = await anthropic().messages.create({
    model: config.anthropic.classifierModel(),
    max_tokens: 256,
    system: CLASSIFY_SYSTEM,
    tools: [CLASSIFY_TOOL],
    tool_choice: { type: "tool", name: "classify_message" },
    messages: [{ role: "user", content: body }],
  });

  const toolUse = response.content.find(
    (c): c is Anthropic.ToolUseBlock => c.type === "tool_use",
  );
  const input = (toolUse?.input ?? {}) as Partial<ClassifyResult> & {
    is_order_confirmation?: boolean;
  };
  return {
    isConfirmation: !!input.is_order_confirmation,
    confidence: input.confidence ?? "low",
    reason: input.reason ?? "classifier returned no reason",
  };
}

// ── Combined gate ───────────────────────────────────────────────────────────

// The single entry point process.ts uses. forwarded → always ingest; scanned →
// prefilter then classifier.
export async function triage(
  msg: MailMessage,
  mode: TriageMode,
): Promise<TriageResult> {
  if (mode === "forwarded") {
    return { decision: "ingest", reason: "forwarded to intake address", confidence: null };
  }

  const pre = prefilter(msg);
  if (!pre.pass) {
    return { decision: "skipped_prefilter", reason: pre.reason, confidence: null };
  }

  const c = await classify(msg);
  if (!c.isConfirmation) {
    return { decision: "skipped_classifier", reason: c.reason, confidence: c.confidence };
  }
  return { decision: "ingest", reason: c.reason, confidence: c.confidence };
}
