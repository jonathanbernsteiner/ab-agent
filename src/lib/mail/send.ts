import "server-only";
import { freshAccessToken, gmailPost } from "./google";
import { updateAccountTokens } from "./store";
import type { MailAccount } from "./types";

// Outbound email via the connected Gmail account (users.messages.send). Used by
// the pushback/chaser composer — the draft the user edited is sent as-is, and
// when the AB arrived through this mailbox the reply threads onto the original
// supplier email (threadId + In-Reply-To).

export interface OutboundMail {
  to: string;
  subject: string;
  body: string; // plain text
  // Threading (both optional): Gmail conversation + original RFC Message-ID.
  threadId?: string | null;
  inReplyTo?: string | null;
}

// RFC 2047 B-encoding for non-ASCII headers (German subjects: "Rückfrage…").
export function encodeHeaderWord(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf-8").toString("base64")}?=`;
}

function wrap76(b64: string): string {
  return b64.replace(/(.{76})/g, "$1\r\n");
}

// A minimal, correct RFC 2822 message: plain-text UTF-8 body, base64-encoded so
// line-length/8-bit rules can't bite, threading headers when replying.
export function buildMime(mail: OutboundMail, from?: string | null): string {
  const headers = [
    ...(from ? [`From: ${from}`] : []), // Gmail also sets this from the account
    `To: ${mail.to}`,
    `Subject: ${encodeHeaderWord(mail.subject)}`,
    ...(mail.inReplyTo
      ? [`In-Reply-To: ${mail.inReplyTo}`, `References: ${mail.inReplyTo}`]
      : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  const body = wrap76(Buffer.from(mail.body, "utf-8").toString("base64"));
  return `${headers.join("\r\n")}\r\n\r\n${body}`;
}

// Standard base64 → URL-safe (what users.messages.send expects in `raw`).
export function toBase64Url(b64: string): string {
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface SendResult {
  id: string;
  threadId?: string;
}

export async function sendViaGmail(
  account: MailAccount,
  mail: OutboundMail,
): Promise<SendResult> {
  if (!mail.to.trim()) throw new Error("Recipient (To) is required.");

  const token = await freshAccessToken(account, (t) =>
    updateAccountTokens(account.id, t.accessToken, t.expiresAt),
  );

  const raw = toBase64Url(
    Buffer.from(buildMime(mail, account.externalEmail), "utf-8").toString("base64"),
  );

  return gmailPost<SendResult>(token, "/messages/send", {
    raw,
    ...(mail.threadId ? { threadId: mail.threadId } : {}),
  });
}
