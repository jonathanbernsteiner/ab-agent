import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { decodeCsv, parseSapCsv } from "@/lib/sap/import";
import { DEFAULT_MAPPING } from "@/lib/sap/mapping";
import { runImport, markChaserSent } from "@/lib/store";
import { getAwaiting } from "@/lib/readmodel";
import {
  learnContact,
  getDefaultContact,
  listContacts,
  deleteContact,
  setDefaultContact,
  supplierKey,
  emailAddressOf,
  displayNameOf,
} from "@/lib/contacts";
import { installFakeDb, readFixtureBytes } from "./helpers/harness";
import type { FakeSupabase } from "./helpers/fake-supabase";

const DOT_MAPPING = { ...DEFAULT_MAPPING, decimal_sep: "." };

// Pin todayIso()/business-day math to a fixed day (same trick as readmodel.test).
async function withToday<T>(iso: string, fn: () => Promise<T>): Promise<T> {
  const RealDate = Date;
  const fixedMs = new RealDate(`${iso}T12:00:00Z`).getTime();
  class FixedDate extends RealDate {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(...args: any[]) {
      if (args.length === 0) super(fixedMs);
      else if (args.length === 1) super(args[0]);
      else super(args[0], args[1], args[2], args[3], args[4], args[5], args[6]);
    }
    static now() {
      return fixedMs;
    }
  }
  (globalThis as { Date: typeof Date }).Date = FixedDate as unknown as typeof Date;
  try {
    return await fn();
  } finally {
    (globalThis as { Date: typeof Date }).Date = RealDate;
  }
}

let db: FakeSupabase;
beforeEach(() => {
  db = installFakeDb();
});

test("supplierKey: letterhead and SAP vendor names resolve to the same key", () => {
  assert.equal(supplierKey("FEDERN VOGEL KG"), supplierKey("Federn Vogel"));
  assert.equal(supplierKey("Gusswerk Hartmann GmbH"), supplierKey("gusswerk hartmann"));
  assert.notEqual(supplierKey("Federn Vogel"), supplierKey("MetallTech"));
});

test("From-header parsing: address and display name", () => {
  assert.equal(emailAddressOf('Anna Huber <anna.huber@vogel.de>'), "anna.huber@vogel.de");
  assert.equal(emailAddressOf("orders@vogel.de"), "orders@vogel.de");
  assert.equal(emailAddressOf(null), null);
  assert.equal(displayNameOf('"Anna Huber" <anna.huber@vogel.de>'), "Anna Huber");
  assert.equal(displayNameOf("orders@vogel.de"), null);
});

test("learnContact: first contact becomes default, repeats dedupe, name backfills", async () => {
  await learnContact({ supplier: "Federn Vogel KG", email: "Orders@Vogel.de", source: "inbound" });
  await learnContact({ supplier: "FEDERN VOGEL", email: "orders@vogel.de", source: "outbound" }); // dup (case + name form)
  await learnContact({ supplier: "Federn Vogel KG", email: "orders@vogel.de", name: "Anna Huber", source: "inbound" });

  let contacts = await listContacts();
  assert.equal(contacts.length, 1, "same address for the same supplier stored once");
  assert.equal(contacts[0].email, "orders@vogel.de", "email normalized to lowercase");
  assert.equal(contacts[0].is_default, true, "first contact is the default");
  assert.equal(contacts[0].name, "Anna Huber", "name backfilled onto the existing row");

  // A second, different address is stored but not default.
  await learnContact({ supplier: "Federn Vogel KG", email: "anna@vogel.de", source: "outbound" });
  contacts = await listContacts();
  assert.equal(contacts.length, 2);
  assert.equal(contacts.find((c) => c.email === "anna@vogel.de")!.is_default, false);

  // Default lookup works from either name form.
  const viaSap = await getDefaultContact("Federn Vogel");
  assert.equal(viaSap?.email, "orders@vogel.de");
});

test("setDefaultContact switches the star; deleteContact removes the row", async () => {
  await learnContact({ supplier: "MetallTech GmbH", email: "a@metalltech.de", source: "inbound" });
  await learnContact({ supplier: "MetallTech GmbH", email: "b@metalltech.de", source: "manual" });

  const contacts = await listContacts();
  const b = contacts.find((c) => c.email === "b@metalltech.de")!;
  await setDefaultContact(b.id);

  const after = await listContacts();
  assert.equal(after.find((c) => c.email === "b@metalltech.de")!.is_default, true);
  assert.equal(after.find((c) => c.email === "a@metalltech.de")!.is_default, false);
  assert.equal((await getDefaultContact("MetallTech GmbH"))?.email, "b@metalltech.de");

  await deleteContact(b.id);
  const remaining = await listContacts();
  assert.equal(remaining.length, 1);
  // The remaining (non-default) contact still resolves as the address to use.
  assert.equal((await getDefaultContact("MetallTech"))?.email, "a@metalltech.de");
});

test("chaser sent → hidden for the follow-up window → resurfaces escalated", async () => {
  const { rows } = parseSapCsv(decodeCsv(readFixtureBytes("po-exports/open_POs_export.csv")), DOT_MAPPING);
  await runImport(rows, "open_POs_export.csv", DOT_MAPPING);

  // Mon 2026-07-13: the Mon-06.07 PO is 5 business days silent — overdue, but
  // still below the time-based level-2 threshold (starts past day 6). The
  // 100-day PO would already sit at level 3 by time, so it can't exercise the
  // sent-level bookkeeping.
  await withToday("2026-07-13", async () => {
    const { overdue } = await getAwaiting();
    assert.ok(overdue.some((c) => c.poNumber === "4500112873"), "PO overdue before sending");

    // The reminder goes out (level 1).
    await markChaserSent("4500112873", 1);

    // Immediately hidden for the follow-up window.
    const after = await getAwaiting();
    assert.ok(!after.overdue.some((c) => c.poNumber === "4500112873"), "hidden after send");

    const chaser = db.all("chasers").find((c) => c.po_number === "4500112873")!;
    assert.equal(chaser.status, "snoozed");
    assert.equal(chaser.level, 2, "escalates so the resurfaced reminder is firm");
    const history = chaser.history as { action: string }[];
    assert.equal(history[history.length - 1].action, "sent_level_1");
  });

  // Fri 2026-07-17: default follow-up window (3 business days) has passed —
  // the PO is back, now at level 2.
  await withToday("2026-07-17", async () => {
    const { overdue } = await getAwaiting();
    const card = overdue.find((c) => c.poNumber === "4500112873");
    assert.ok(card, "resurfaces after the follow-up window");
    assert.equal(card!.level, 2, "resurfaced reminder is level 2 (with deadline)");
    assert.match(card!.chaser.subject, /2\. Erinnerung/, "level-2 draft has the firm subject");

    // The firm reminder goes out too — bumps the stored level to 3.
    await markChaserSent("4500112873", 2);
    const chaser = db.all("chasers").find((c) => c.po_number === "4500112873")!;
    assert.equal(chaser.level, 3, "second sent reminder escalates to level 3");
  });

  // Thu 2026-07-23: still silent after the second follow-up window — the third
  // round is an internal escalation (owner/manager), not another supplier mail.
  await withToday("2026-07-23", async () => {
    const { overdue } = await getAwaiting();
    const card = overdue.find((c) => c.poNumber === "4500112873");
    assert.ok(card, "resurfaces again after the second follow-up window");
    assert.equal(card!.level, 3, "third round is the escalation level");
    assert.match(card!.chaser.subject, /Eskalation/, "level-3 draft is the internal escalation mail");
  });
});
