import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { decodeCsv, parseSapCsv } from "@/lib/sap/import";
import { DEFAULT_MAPPING } from "@/lib/sap/mapping";
import { runImport } from "@/lib/store";
import { getAwaiting } from "@/lib/readmodel";
import { installFakeDb, readFixtureBytes } from "./helpers/harness";

const DOT_MAPPING = { ...DEFAULT_MAPPING, decimal_sep: "." };

// Pin todayIso()/business-day math to the fixture's TODAY (Mon 2026-07-13),
// since the machine clock differs. Restores the real Date afterwards.
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

beforeEach(async () => {
  installFakeDb();
  const { rows } = parseSapCsv(decodeCsv(readFixtureBytes("po-exports/open_POs_export.csv")), DOT_MAPPING);
  await runImport(rows, "open_POs_export.csv", DOT_MAPPING);
});

test("getAwaiting splits open, AB-less POs into overdue vs pending", async () => {
  const { overdue, pending } = await withToday("2026-07-13", () => getAwaiting());

  const overduePos = new Set(overdue.map((c) => c.poNumber));
  const pendingPos = new Set(pending.map((c) => c.poNumber));

  // The 100-day long-lead casting is unambiguously overdue and fully escalated:
  // past overdue + 2× the follow-up window, the third round goes internal.
  assert.ok(overduePos.has("4500112650"), "100-day-old casting is overdue");
  const worst = overdue.find((c) => c.poNumber === "4500112650")!;
  assert.equal(worst.level, 3, "long silence escalates to level 3 (internal escalation)");
  assert.ok(worst.businessDaysWaiting > 6);
  assert.match(worst.chaser.subject, /4500112650/, "chaser draft references the PO");
  assert.match(worst.chaser.subject, /Eskalation/, "level-3 draft is the internal escalation mail");

  // A PO placed a day ago is still inside the silent window.
  assert.ok(pendingPos.has("4500113001"), "1-day-old PO is pending, not overdue");

  // SAP-confirmed and already-matched lines never appear in the awaiting queue.
  assert.ok(!overduePos.has("4500112940") && !pendingPos.has("4500112940"), "confirmed PO excluded");

  // Every awaiting PO is in exactly one bucket.
  for (const p of overduePos) assert.ok(!pendingPos.has(p), `${p} not double-counted`);

  // Overdue list is sorted by how long it has waited, longest first.
  const waits = overdue.map((c) => c.businessDaysWaiting);
  assert.deepEqual(waits, [...waits].sort((a, b) => b - a), "overdue sorted by wait desc");
});
