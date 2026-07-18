import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installFakeDb, TEST_COMPANY_ID } from "./helpers/harness";
import {
  __setTestGoogleFetch,
  base64UrlToBase64,
  extractBodyText,
  htmlToText,
  normalizeGmailMessage,
  type GmailMessageRaw,
} from "@/lib/mail/google";
import { buildMime, encodeHeaderWord, sendViaGmail, toBase64Url } from "@/lib/mail/send";
import { getProvider } from "@/lib/mail/providers";
import type { MailAccount } from "@/lib/mail/types";

// The Gmail integration's own mechanics — MIME building, message normalization,
// the history/backfill poll paths, and send — against a fake fetch, fully
// offline. The OAuth redirect dance itself is browser-tested, not unit-tested.

function b64url(s: string): string {
  return Buffer.from(s, "utf-8").toString("base64url");
}

// Minimal fake fetch: match the first route whose substring appears in the URL.
function fakeGoogleFetch(
  routes: [string, (url: string, init?: RequestInit) => unknown][],
  calls?: { url: string; init?: RequestInit }[],
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls?.push({ url, init });
    for (const [needle, responder] of routes) {
      if (url.includes(needle)) {
        return new Response(JSON.stringify(responder(url, init)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    return new Response(JSON.stringify({ error: `no fake route for ${url}` }), { status: 404 });
  }) as typeof fetch;
}

const validAccount: MailAccount = {
  id: "acc-g",
  companyId: TEST_COMPANY_ID,
  provider: "gmail",
  externalEmail: "einkauf@example.com",
  status: "connected",
  cursor: "100",
  accessToken: "tok-live",
  refreshToken: "refresh-1",
  tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
};

// A realistic multipart message: text/plain + text/html alternative, one PDF
// attachment that must be fetched separately (attachmentId), Message-ID header.
const fullMessage: GmailMessageRaw = {
  id: "m1",
  threadId: "t1",
  labelIds: ["INBOX", "IMPORTANT"],
  internalDate: "1752300000000",
  payload: {
    mimeType: "multipart/mixed",
    headers: [
      { name: "From", value: "Federn Vogel <vertrieb@federn-vogel.de>" },
      { name: "Subject", value: "Auftragsbestätigung 998 zu Bestellung 4500001234" },
      { name: "Message-ID", value: "<abc-123@mail.federn-vogel.de>" },
    ],
    parts: [
      {
        mimeType: "multipart/alternative",
        parts: [
          { mimeType: "text/plain", body: { data: b64url("Sehr geehrte Damen und Herren,\nanbei die AB.") } },
          { mimeType: "text/html", body: { data: b64url("<p>Sehr geehrte Damen und Herren,</p>") } },
        ],
      },
      {
        mimeType: "application/pdf",
        filename: "AB-998.pdf",
        body: { attachmentId: "att-1", size: 8 },
      },
    ],
  },
};

beforeEach(() => {
  installFakeDb();
});

afterEach(() => {
  __setTestGoogleFetch(null);
});

// ── Pure helpers ─────────────────────────────────────────────────────────────

test("base64url→base64 round-trips content with URL-unsafe bytes", () => {
  const bytes = Buffer.from([251, 255, 190, 0, 62, 63]); // encodes to +, / in std b64
  const url = bytes.toString("base64url");
  assert.equal(Buffer.from(base64UrlToBase64(url), "base64").compare(bytes), 0);
});

test("encodeHeaderWord leaves ASCII alone and B-encodes umlauts", () => {
  assert.equal(encodeHeaderWord("Order confirmation 998"), "Order confirmation 998");
  const encoded = encodeHeaderWord("Rückfrage zur Auftragsbestätigung");
  assert.match(encoded, /^=\?UTF-8\?B\?.+\?=$/);
  const b64 = encoded.slice("=?UTF-8?B?".length, -"?=".length);
  assert.equal(Buffer.from(b64, "base64").toString("utf-8"), "Rückfrage zur Auftragsbestätigung");
});

test("htmlToText strips markup but keeps the words triage needs", () => {
  const text = htmlToText("<div><p>Bestellnummer <b>4500001234</b></p><br><script>x()</script></div>");
  assert.match(text, /Bestellnummer 4500001234/);
  assert.doesNotMatch(text, /script|x\(\)/);
});

test("extractBodyText prefers text/plain over text/html", () => {
  assert.equal(
    extractBodyText(fullMessage.payload),
    "Sehr geehrte Damen und Herren,\nanbei die AB.",
  );
});

// ── Normalization ────────────────────────────────────────────────────────────

test("normalizeGmailMessage maps headers, body, threading and fetches the PDF", async () => {
  __setTestGoogleFetch(
    fakeGoogleFetch([["/messages/m1/attachments/att-1", () => ({ data: b64url("PDFBYTES") })]]),
  );

  const msg = await normalizeGmailMessage("tok", fullMessage);
  assert.ok(msg);
  assert.equal(msg.externalId, "m1");
  assert.equal(msg.from, "Federn Vogel <vertrieb@federn-vogel.de>");
  assert.equal(msg.subject, "Auftragsbestätigung 998 zu Bestellung 4500001234");
  assert.equal(msg.threadId, "t1");
  assert.equal(msg.rfcMessageId, "<abc-123@mail.federn-vogel.de>");
  assert.equal(msg.attachments.length, 1);
  assert.equal(msg.attachments[0].filename, "AB-998.pdf");
  // Standard base64, decodable by the pipeline.
  assert.equal(Buffer.from(msg.attachments[0].base64, "base64").toString(), "PDFBYTES");
});

test("normalizeGmailMessage drops our own sent mail and drafts", async () => {
  for (const label of ["SENT", "DRAFT", "SPAM", "TRASH"]) {
    const msg = await normalizeGmailMessage("tok", { ...fullMessage, labelIds: [label] });
    assert.equal(msg, null, `${label} must be ignored`);
  }
});

// ── Poll paths ───────────────────────────────────────────────────────────────

test("gmail provider: history delta path returns new messages and advances the cursor", async () => {
  __setTestGoogleFetch(
    fakeGoogleFetch([
      ["/history?", (url) => {
        assert.match(url, /startHistoryId=100/);
        return { history: [{ messagesAdded: [{ message: { id: "m1" } }] }], historyId: "200" };
      }],
      ["/messages/m1/attachments/att-1", () => ({ data: b64url("PDFBYTES") })],
      ["/messages/m1?format=full", () => fullMessage],
    ]),
  );

  const { messages, cursor } = await getProvider("gmail").listNewMessages(validAccount);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].externalId, "m1");
  assert.equal(cursor, "200");
});

test("gmail provider: first sync (no cursor) backfills recent mail and pins the cursor", async () => {
  const textOnly: GmailMessageRaw = {
    id: "m2",
    threadId: "t2",
    labelIds: ["INBOX"],
    payload: {
      mimeType: "text/plain",
      headers: [{ name: "From", value: "a@b.de" }, { name: "Subject", value: "Hallo" }],
      body: { data: b64url("Nur Text.") },
    },
  };
  __setTestGoogleFetch(
    fakeGoogleFetch([
      ["/profile", () => ({ emailAddress: "einkauf@example.com", historyId: "555" })],
      ["/messages/m2?format=full", () => textOnly],
      ["/messages?", (url) => {
        assert.match(url, /newer_than%3A7d|newer_than:7d/);
        return { messages: [{ id: "m2" }] };
      }],
    ]),
  );

  const { messages, cursor } = await getProvider("gmail").listNewMessages({
    ...validAccount,
    cursor: null,
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, "Nur Text.");
  assert.equal(cursor, "555", "cursor pinned to the profile historyId");
});

test("gmail provider: expired history (404) falls back to the recency scan", async () => {
  __setTestGoogleFetch(
    (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/history?")) return new Response("history too old", { status: 404 });
      if (url.includes("/profile")) {
        return Response.json({ emailAddress: "einkauf@example.com", historyId: "900" });
      }
      if (url.includes("/messages?")) return Response.json({ messages: [] });
      return new Response("{}", { status: 404 });
    }) as typeof fetch,
  );

  const { messages, cursor } = await getProvider("gmail").listNewMessages(validAccount);
  assert.equal(messages.length, 0);
  assert.equal(cursor, "900");
});

// ── Send ─────────────────────────────────────────────────────────────────────

test("buildMime produces a threading reply whose body decodes back verbatim", () => {
  const mime = buildMime(
    {
      to: "vertrieb@federn-vogel.de",
      subject: "Rückfrage zur Auftragsbestätigung – Bestellung 4500001234",
      body: "Sehr geehrte Damen und Herren,\n\nbitte prüfen Sie die Abweichungen.\n\nGrüße",
      inReplyTo: "<abc-123@mail.federn-vogel.de>",
    },
    "einkauf@example.com",
  );

  assert.match(mime, /^From: einkauf@example\.com\r\n/);
  assert.match(mime, /\r\nTo: vertrieb@federn-vogel\.de\r\n/);
  assert.match(mime, /\r\nSubject: =\?UTF-8\?B\?/);
  assert.match(mime, /\r\nIn-Reply-To: <abc-123@mail\.federn-vogel\.de>\r\n/);
  assert.match(mime, /\r\nReferences: <abc-123@mail\.federn-vogel\.de>\r\n/);

  const body = mime.split("\r\n\r\n")[1].replace(/\r\n/g, "");
  assert.equal(
    Buffer.from(body, "base64").toString("utf-8"),
    "Sehr geehrte Damen und Herren,\n\nbitte prüfen Sie die Abweichungen.\n\nGrüße",
  );
});

test("sendViaGmail posts base64url raw + threadId to users.messages.send", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  __setTestGoogleFetch(
    fakeGoogleFetch([["/messages/send", () => ({ id: "sent-1", threadId: "t1" })]], calls),
  );

  const result = await sendViaGmail(validAccount, {
    to: "vertrieb@federn-vogel.de",
    subject: "Test",
    body: "Hallo",
    threadId: "t1",
    inReplyTo: "<abc-123@mail.federn-vogel.de>",
  });

  assert.equal(result.id, "sent-1");
  const send = calls.find((c) => c.url.includes("/messages/send"));
  assert.ok(send);
  const payload = JSON.parse(String(send.init?.body)) as { raw: string; threadId?: string };
  assert.equal(payload.threadId, "t1");
  // raw is URL-safe base64 of the whole RFC 2822 message.
  const mime = Buffer.from(toBase64Url(payload.raw) === payload.raw ? base64UrlToBase64(payload.raw) : payload.raw, "base64").toString("utf-8");
  assert.match(mime, /To: vertrieb@federn-vogel\.de/);
  assert.match(mime, /In-Reply-To: <abc-123@mail\.federn-vogel\.de>/);
});

test("sendViaGmail refuses an empty recipient", async () => {
  await assert.rejects(
    () => sendViaGmail(validAccount, { to: "  ", subject: "s", body: "b" }),
    /Recipient/,
  );
});
