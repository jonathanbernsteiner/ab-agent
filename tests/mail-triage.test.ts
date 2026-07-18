import { test } from "node:test";
import assert from "node:assert/strict";
import { prefilter } from "@/lib/mail/triage";
import type { MailMessage } from "@/lib/mail/types";

// The free, deterministic pre-filter — the first gate that keeps the whole-mailbox
// scan from spending an LLM call on every newsletter. Runs fully offline (no key).

function msg(partial: Partial<MailMessage>): MailMessage {
  return {
    externalId: "m1",
    from: "someone@example.com",
    subject: null,
    text: null,
    attachments: [],
    ...partial,
  };
}

test("prefilter passes a message with a PDF attachment", () => {
  const r = prefilter(
    msg({ attachments: [{ filename: "AB.pdf", contentType: "application/pdf", base64: "x" }] }),
  );
  assert.equal(r.pass, true);
});

test("prefilter passes when a SAP PO number (45…) appears in the text", () => {
  const r = prefilter(msg({ subject: "Bestellung", text: "zu Ihrer Bestellung 4500112944 vom ..." }));
  assert.equal(r.pass, true);
});

test("prefilter passes on order-confirmation vocabulary", () => {
  assert.equal(prefilter(msg({ subject: "Auftragsbestätigung 12345" })).pass, true);
  assert.equal(prefilter(msg({ subject: "Your Order Confirmation" })).pass, true);
});

test("prefilter skips obvious non-ABs (no PDF, no PO number, no AB terms)", () => {
  assert.equal(prefilter(msg({ subject: "Newsletter: 20% off springs!", text: "Shop now" })).pass, false);
  assert.equal(prefilter(msg({ subject: "Out of office", text: "I am away until Monday." })).pass, false);
  assert.equal(prefilter(msg({})).pass, false);
});

test("prefilter is case-insensitive and matches German umlaut term", () => {
  assert.equal(prefilter(msg({ text: "AUFTRAGSBESTÄTIGUNG folgt anbei" })).pass, true);
});
