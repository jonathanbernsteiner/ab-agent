import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installFakeDb, TEST_COMPANY_ID } from "./helpers/harness";
import type { FakeSupabase } from "./helpers/fake-supabase";
import { getConnectedAccounts } from "@/lib/mail/store";
import { pollMailbox } from "@/lib/mail/loop";
import { __setTestProvider } from "@/lib/mail/providers";
import { __setTestClassifier } from "@/lib/mail/triage";
import type { MailMessage } from "@/lib/mail/types";

// The scan loop's own mechanics — fetch, dedupe, triage routing, audit logging,
// cursor advance — with a fake provider and a stubbed classifier so it runs fully
// offline. The actual extraction (the "ingest" branch) is covered by the gated
// pipeline.model tests; here we drive the two skip paths + idempotency.

let db: FakeSupabase;
let classifyCalls = 0;

const junk: MailMessage = {
  externalId: "g-1",
  from: "hr@example.com",
  subject: "Team lunch Friday",
  text: "See you in the kitchen at noon.",
  attachments: [],
};

const maybeAb: MailMessage = {
  externalId: "g-2",
  from: "vertrieb@federn-vogel.de",
  subject: "Auftragsbestätigung 998",
  text: "Sehr geehrte Damen und Herren, anbei unsere Bestätigung.",
  attachments: [],
};

beforeEach(async () => {
  db = installFakeDb();
  classifyCalls = 0;

  // A connected Gmail mailbox for the test tenant.
  await db.from("mail_accounts").insert({
    id: "acc-1",
    company_id: TEST_COMPANY_ID,
    provider: "gmail",
    external_email: "clerk@example.com",
    status: "connected",
    cursor: null,
  });

  // Provider that re-delivers the same two messages on every poll (worst case
  // for idempotency).
  __setTestProvider("gmail", {
    id: "gmail",
    label: "Gmail (test)",
    connectable: true,
    async listNewMessages() {
      return { messages: [junk, maybeAb], cursor: "hist-2" };
    },
  });

  // Classifier that rejects everything it's asked about (so nothing hits the real
  // extraction pipeline) — and counts its calls so we can prove the free prefilter
  // gated the obvious junk before the paid model.
  __setTestClassifier(async () => {
    classifyCalls++;
    return { isConfirmation: false, confidence: "low", reason: "not an AB (test)" };
  });
});

afterEach(() => {
  __setTestProvider("gmail", null);
  __setTestClassifier(null);
});

test("poll routes junk to prefilter-skip and an AB-looking mail to the classifier", async () => {
  const [account] = await getConnectedAccounts();
  assert.ok(account, "the connected account is discovered");

  const summary = await pollMailbox(account);

  assert.equal(summary.fetched, 2);
  assert.equal(summary.processed, 2);
  assert.equal(summary.ingested, 0);
  assert.equal(summary.skipped, 2);
  // Only the AB-looking message reached the (paid) classifier; the newsletter was
  // rejected for free by the deterministic prefilter.
  assert.equal(classifyCalls, 1);

  const events = db.all("mail_events");
  assert.equal(events.length, 2);
  const decisions = events.map((e) => e.decision).sort();
  assert.deepEqual(decisions, ["skipped_classifier", "skipped_prefilter"]);

  // Cursor advanced so the next poll resumes after these.
  const acct = db.all("mail_accounts").find((a) => a.id === "acc-1");
  assert.equal(acct?.cursor, "hist-2");
});

test("re-polling the same messages processes nothing (at-most-once)", async () => {
  const [account] = await getConnectedAccounts();

  await pollMailbox(account);
  assert.equal(db.all("mail_events").length, 2);

  const second = await pollMailbox(account);
  assert.equal(second.fetched, 2, "provider still offered both");
  assert.equal(second.processed, 0, "but both were already seen");
  assert.equal(db.all("mail_events").length, 2, "no duplicate audit rows");
});
