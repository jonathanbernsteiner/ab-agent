"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Download, Search, Send, Upload } from "lucide-react";
import { StatusPill } from "@/components/ui/panel";
import Drawer, { type DrawerEntry } from "@/components/Drawer";
import { formatEn } from "@/lib/dates";
import type { MatchingData, MatchTab, MatchQueue, PoCard } from "@/lib/views";

const TABS: { key: MatchTab; label: string }[] = [
  { key: "inbox", label: "Inbox" },
  { key: "orders", label: "All POs" },
];

// Inbox groups, in work order: decide first (blocks the export), then chase,
// then escalate (two reminders unanswered — goes internal), then check.
const QUEUES: { key: MatchQueue; title: string; hint: string }[] = [
  { key: "decide", title: "Decide", hint: "deviation — accept or push back" },
  { key: "chase", title: "Chase", hint: "no confirmation — remind the supplier" },
  { key: "escalate", title: "Escalate", hint: "two reminders unanswered — hand it to the PO owner or your manager" },
  { key: "check", title: "Check", hint: "changed in SAP or stuck waiting for import" },
];

// Status filter on All POs. "done" is a group (confirmed + exported + closed) so
// the old Done tab's deep links keep working.
const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "All statuses" },
  { value: "awaiting", label: "Awaiting" },
  { value: "overdue", label: "Overdue" },
  { value: "to_review", label: "To review" },
  { value: "waiting_import", label: "Waiting for import" },
  { value: "externally_changed", label: "Changed in SAP" },
  { value: "confirmed", label: "Confirmed" },
  { value: "exported", label: "Exported" },
  { value: "archived", label: "Closed" },
  { value: "done", label: "Done (confirmed + exported + closed)" },
];

const PAGE = 50;

// Selection key: PO cards and waiting-import AB cards can share a poNumber.
function keyOf(c: PoCard): string {
  return `${c.poNumber}-${c.abId ?? "po"}`;
}

// Download the ticked rows as a CSV (BOM + CRLF so Excel opens it cleanly).
function downloadCsv(cards: PoCard[]) {
  const esc = (v: string | number | null) => {
    const s = v == null ? "" : String(v);
    return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ["PO", "Confirmation", "Supplier", "Lines", "Deviating", "Requested", "Confirmed", "Status", "Queue", "Key findings", "Age (days)"];
  const rows = cards.map((c) =>
    [c.poNumber, c.abNumber, c.supplier, c.lineCount, c.deviatingCount, c.requestedDate, c.confirmedDate, c.status, c.queue, c.keyFindings, c.ageDays]
      .map(esc)
      .join(","),
  );
  const blob = new Blob(["\uFEFF" + [header.join(","), ...rows].join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ab-agent-pos-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function matchesStatus(card: PoCard, status: string): boolean {
  if (!status) return true;
  if (status === "done") {
    return card.status === "confirmed" || card.status === "exported" || card.status === "archived";
  }
  return card.status === status;
}

export default function MatchingClient({
  data,
  initialTab = "inbox",
  initialStatus = "",
}: {
  data: MatchingData;
  initialTab?: MatchTab;
  initialStatus?: string;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<MatchTab>(initialTab);
  const [queue, setQueue] = useState<MatchQueue | "all">("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkNote, setBulkNote] = useState<string | null>(null);
  const [merge, setMerge] = useState(true);
  const [q, setQ] = useState("");
  const [supplier, setSupplier] = useState("");
  const [status, setStatus] = useState(initialStatus);
  const [shown, setShown] = useState(PAGE);
  const [entry, setEntry] = useState<DrawerEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const suppliers = useMemo(
    () => Array.from(new Set(data.cards.map((c) => c.supplier).filter(Boolean))) as string[],
    [data.cards],
  );

  // All POs: every card through search + supplier + status.
  const orderCards = data.cards.filter((c) => {
    if (supplier && c.supplier !== supplier) return false;
    if (!matchesStatus(c, status)) return false;
    if (q) {
      const hay = `${c.poNumber} ${c.abNumber ?? ""} ${c.supplier ?? ""}`.toLowerCase();
      if (!hay.includes(q.toLowerCase())) return false;
    }
    return true;
  });
  const visibleOrders = orderCards.slice(0, shown);

  function refresh() {
    router.refresh();
  }

  function open(card: PoCard) {
    // waiting_import cards have no spine lines yet — open the AB document.
    if (card.status === "waiting_import" && card.abId) setEntry({ type: "ab", id: card.abId });
    else setEntry({ type: "po", id: card.poNumber });
  }

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    setNote(null);
    try {
      const form = new FormData();
      for (const f of Array.from(files)) form.append("file", f);
      const res = await fetch("/api/upload", { method: "POST", body: form });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setNote(json?.error ?? "Upload failed.");
      } else {
        const msgs = (json?.results ?? []).map((r: { message?: string; error?: string }) => r.error ?? r.message).filter(Boolean);
        setNote(msgs[0] ?? "Processed.");
      }
    } catch {
      setNote("Upload failed.");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
      refresh();
    }
  }

  async function bulkAction(action: "send" | "snooze" | "resolve" | "escalated", poNumbers: string[]) {
    if (poNumbers.length === 0) return;
    setBulkBusy(true);
    setBulkNote(null);
    try {
      const res = await fetch("/api/chasers/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poNumbers, action, merge }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setBulkNote(json?.error ?? "Bulk action failed.");
      } else if (action === "send") {
        const parts = [
          merge && json.sent !== json.emails
            ? `${json.sent} POs chased in ${json.emails} email${json.emails === 1 ? "" : "s"}`
            : `${json.sent} reminder${json.sent === 1 ? "" : "s"} sent`,
        ];
        if (json.noContact?.length) parts.push(`${json.noContact.length} skipped — no contact email saved`);
        if (json.notDue?.length) parts.push(`${json.notDue.length} skipped — no longer overdue`);
        if (json.escalate?.length) parts.push(`${json.escalate.length} skipped — needs internal escalation, not a supplier mail`);
        if (json.failed?.length) parts.push(`${json.failed.length} failed`);
        setBulkNote(parts.join(" · "));
      } else if (action === "escalated") {
        setBulkNote(`${json.done} marked escalated — hidden until the follow-up window passes.`);
      } else {
        setBulkNote(action === "snooze" ? `${json.done} snoozed for 2 business days.` : `${json.done} marked resolved.`);
      }
    } catch {
      setBulkNote("Bulk action failed.");
    } finally {
      setBulkBusy(false);
      setSelected(new Set());
      refresh();
    }
  }

  return (
    <div style={{ padding: 32, maxWidth: 1180 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, marginBottom: 18 }}>
        <div>
          <h2 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Matching</h2>
          <p style={{ color: "#64748B", fontSize: 14, marginTop: 4 }}>
            Every PO and its confirmation in one place.
            {data.digestCount > 0 && <> {data.digestCount} auto-confirmed today.</>}
          </p>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
          <label
            style={{
              display: "inline-flex", alignItems: "center", gap: 8, cursor: busy ? "default" : "pointer",
              border: "1px solid #E2E8F0", background: "#fff", borderRadius: 8, padding: "8px 12px",
              fontSize: 13.5, fontWeight: 600, color: "#0F172A", opacity: busy ? 0.6 : 1,
            }}
          >
            <Upload size={15} style={{ color: "var(--primary)" }} />
            {busy ? "Uploading…" : "Upload confirmation"}
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf"
              multiple
              disabled={busy}
              onChange={(e) => upload(e.target.files)}
              style={{ display: "none" }}
            />
          </label>
          {note && <span style={{ fontSize: 12, color: "#64748B", maxWidth: 320, textAlign: "right" }}>{note}</span>}
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 4, borderBottom: "1px solid #E2E8F0" }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => { setTab(t.key); setSelected(new Set()); setBulkNote(null); }}
            style={{
              padding: "10px 14px", background: "transparent", border: "none", cursor: "pointer",
              fontSize: 14, fontWeight: tab === t.key ? 700 : 500,
              color: tab === t.key ? "#0F172A" : "#64748B",
              borderBottom: tab === t.key ? "2px solid var(--primary)" : "2px solid transparent",
              marginBottom: -1,
            }}
          >
            {t.label} <span style={{ color: "#94A3B8" }}>{t.key === "inbox" ? data.counts.inbox : data.counts.all}</span>
          </button>
        ))}
      </div>

      {tab === "inbox" ? (
        <div style={{ marginTop: 14 }}>
          {/* Queue filter pills: All + non-empty queues, in work order. */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {[{ key: "all" as MatchQueue | "all", title: "All", hint: null as string | null, count: data.counts.inbox }]
              .concat(
                QUEUES.map((qd) => ({
                  key: qd.key as MatchQueue | "all",
                  title: qd.title,
                  hint: qd.hint as string | null,
                  count: data.cards.filter((c) => c.queue === qd.key).length,
                })).filter((qd) => qd.count > 0),
              )
              .map((qd) => {
                const active = queue === qd.key;
                return (
                  <button
                    key={qd.key}
                    onClick={() => { setQueue(qd.key); setSelected(new Set()); setBulkNote(null); }}
                    style={{
                      display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer",
                      border: active ? "1px solid var(--primary)" : "1px solid #E2E8F0",
                      background: active ? "#EEEDFF" : "#fff",
                      color: active ? "var(--primary)" : "#334155",
                      borderRadius: 999, padding: "6px 14px", fontSize: 13, fontWeight: 600,
                    }}
                  >
                    {qd.title}
                    <span style={{ fontWeight: 500, color: active ? "var(--primary)" : "#94A3B8" }}>{qd.count}</span>
                  </button>
                );
              })}
          </div>

          {(() => {
            const activeQueue = QUEUES.find((qd) => qd.key === queue);
            const queueRank = (c: PoCard) => QUEUES.findIndex((qd) => qd.key === c.queue);
            const cards = data.cards
              .filter((c) => (queue === "all" ? c.queue !== null : c.queue === queue))
              .sort((a, b) => queueRank(a) - queueRank(b));
            const selectedCards = cards.filter((c) => selected.has(keyOf(c)));
            // Chaser actions only make sense for POs still waiting on a
            // confirmation. Send targets the Chase rows (supplier reminders);
            // "Mark escalated" targets the Escalate rows (handled internally);
            // snooze/resolve apply to both.
            const chaseCards = selectedCards.filter((c) => c.queue === "chase");
            const chasePos = chaseCards.map((c) => c.poNumber);
            const escalatePos = selectedCards.filter((c) => c.queue === "escalate").map((c) => c.poNumber);
            const waitingPos = [...chasePos, ...escalatePos];
            const supplierCount = new Set(chaseCards.map((c) => c.supplier ?? `#${c.poNumber}`)).size;
            return (
              <>
                {activeQueue && cards.length > 0 && (
                  <div style={{ marginTop: 14, fontSize: 13, color: "#64748B" }}>{activeQueue.hint}</div>
                )}
                {bulkNote && (
                  <div style={{ marginTop: 12, fontSize: 13, color: "#334155", background: "#F1F5F9", border: "1px solid #E2E8F0", borderRadius: 8, padding: "8px 12px" }}>
                    {bulkNote}
                  </div>
                )}
                {selectedCards.length > 0 && (
                  <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", background: "#EEEDFF", border: "1px solid #C9C7FF", borderRadius: 8, padding: "8px 12px" }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: "#0F172A", marginRight: 4 }}>
                      {selectedCards.length} selected
                    </span>
                    <button
                      onClick={() => bulkAction("send", chasePos)}
                      disabled={bulkBusy || chasePos.length === 0}
                      style={{ ...bulkBtn, background: "var(--primary)", borderColor: "var(--primary)", color: "#fff", opacity: bulkBusy || chasePos.length === 0 ? 0.5 : 1 }}
                    >
                      <Send size={13} />
                      {bulkBusy
                        ? "Sending…"
                        : merge && chasePos.length > supplierCount
                          ? `Send reminders (${chasePos.length} POs · ${supplierCount} emails)`
                          : `Send reminders (${chasePos.length})`}
                    </button>
                    {chasePos.length > 1 && (
                      <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "#334155", cursor: "pointer" }}>
                        <input
                          type="checkbox"
                          checked={merge}
                          onChange={(e) => setMerge(e.target.checked)}
                          style={{ ...checkbox, width: 13, height: 13 }}
                        />
                        One email per supplier
                      </label>
                    )}
                    {escalatePos.length > 0 && (
                      <button
                        onClick={() => bulkAction("escalated", escalatePos)}
                        disabled={bulkBusy}
                        style={{ ...bulkBtn, borderColor: "var(--overdue, #DC2626)", color: "var(--overdue, #DC2626)", opacity: bulkBusy ? 0.5 : 1 }}
                      >
                        Mark escalated ({escalatePos.length})
                      </button>
                    )}
                    <button onClick={() => bulkAction("snooze", waitingPos)} disabled={bulkBusy || waitingPos.length === 0} style={{ ...bulkBtn, opacity: bulkBusy || waitingPos.length === 0 ? 0.5 : 1 }}>
                      Snooze 2 days
                    </button>
                    <button onClick={() => bulkAction("resolve", waitingPos)} disabled={bulkBusy || waitingPos.length === 0} style={{ ...bulkBtn, opacity: bulkBusy || waitingPos.length === 0 ? 0.5 : 1 }}>
                      Mark resolved
                    </button>
                    <button onClick={() => downloadCsv(selectedCards)} disabled={bulkBusy} style={{ ...bulkBtn, opacity: bulkBusy ? 0.5 : 1 }}>
                      <Download size={13} /> Download CSV
                    </button>
                    {waitingPos.length < selectedCards.length && (
                      <span style={{ fontSize: 12, color: "#64748B" }}>
                        chaser actions apply to the {waitingPos.length} Chase/Escalate PO{waitingPos.length === 1 ? "" : "s"} selected
                      </span>
                    )}
                    <button onClick={() => setSelected(new Set())} disabled={bulkBusy} style={{ ...bulkBtn, border: "none", background: "transparent", color: "#64748B", marginLeft: "auto" }}>
                      Clear
                    </button>
                  </div>
                )}
                <CardTable
                  cards={cards}
                  onOpen={open}
                  style={{ marginTop: activeQueue ? 6 : 14 }}
                  selected={selected}
                  onToggle={(key) =>
                    setSelected((prev) => {
                      const next = new Set(prev);
                      if (next.has(key)) next.delete(key);
                      else next.add(key);
                      return next;
                    })
                  }
                  onToggleAll={() =>
                    setSelected((prev) =>
                      cards.every((c) => prev.has(keyOf(c))) ? new Set() : new Set(cards.map(keyOf)),
                    )
                  }
                />
                {cards.length === 0 && (
                  <div style={{ padding: 48, textAlign: "center", color: "#94A3B8", fontSize: 14 }}>
                    {data.counts.inbox === 0 ? "All clear — nothing needs you." : "Nothing in this queue."}
                  </div>
                )}
              </>
            );
          })()}
        </div>
      ) : (
        <>
          {/* Toolbar (All POs only — the Inbox is short by definition) */}
          <div style={{ display: "flex", gap: 10, margin: "14px 0", flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, border: "1px solid #E2E8F0", borderRadius: 8, padding: "6px 10px", background: "#fff", flex: 1, minWidth: 220 }}>
              <Search size={14} style={{ color: "#94A3B8" }} />
              <input
                value={q}
                onChange={(e) => { setQ(e.target.value); setShown(PAGE); }}
                placeholder="Search PO, confirmation, supplier…"
                style={{ border: "none", outline: "none", fontSize: 13.5, flex: 1, background: "transparent" }}
              />
            </div>
            <select value={status} onChange={(e) => { setStatus(e.target.value); setShown(PAGE); }} style={select}>
              {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <select value={supplier} onChange={(e) => { setSupplier(e.target.value); setShown(PAGE); }} style={select}>
              <option value="">All suppliers</option>
              {suppliers.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          {(() => {
            const selectedOrders = visibleOrders.filter((c) => selected.has(keyOf(c)));
            return (
              selectedOrders.length > 0 && (
                <div style={{ marginBottom: 12, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", background: "#EEEDFF", border: "1px solid #C9C7FF", borderRadius: 8, padding: "8px 12px" }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "#0F172A", marginRight: 4 }}>
                    {selectedOrders.length} selected
                  </span>
                  <button onClick={() => downloadCsv(selectedOrders)} style={bulkBtn}>
                    <Download size={13} /> Download CSV
                  </button>
                  <button onClick={() => setSelected(new Set())} style={{ ...bulkBtn, border: "none", background: "transparent", color: "#64748B", marginLeft: "auto" }}>
                    Clear
                  </button>
                </div>
              )
            );
          })()}
          <CardTable
            cards={visibleOrders}
            onOpen={open}
            selected={selected}
            onToggle={(key) =>
              setSelected((prev) => {
                const next = new Set(prev);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                return next;
              })
            }
            onToggleAll={() =>
              setSelected((prev) =>
                visibleOrders.every((c) => prev.has(keyOf(c))) ? new Set() : new Set(visibleOrders.map(keyOf)),
              )
            }
          />
          {orderCards.length === 0 && (
            <div style={{ padding: 48, textAlign: "center", color: "#94A3B8", fontSize: 14 }}>No POs.</div>
          )}
          {orderCards.length > shown && (
            <div style={{ textAlign: "center", marginTop: 14 }}>
              <button
                onClick={() => setShown((n) => n + PAGE)}
                style={{ border: "1px solid #E2E8F0", background: "#fff", borderRadius: 8, padding: "8px 16px", fontSize: 13.5, fontWeight: 600, color: "#0F172A", cursor: "pointer" }}
              >
                Show more ({orderCards.length - shown} remaining)
              </button>
            </div>
          )}
        </>
      )}

      <Drawer entry={entry} onClose={() => setEntry(null)} onChanged={refresh} onNavigate={(e) => setEntry(e)} />
    </div>
  );
}

// One row per PO. Line detail (parts, quantities, prices) lives in the drawer.
// Passing `selected` + toggle handlers adds a checkbox column for bulk actions.
function CardTable({
  cards,
  onOpen,
  style,
  selected,
  onToggle,
  onToggleAll,
}: {
  cards: PoCard[];
  onOpen: (c: PoCard) => void;
  style?: React.CSSProperties;
  selected?: Set<string>;
  onToggle?: (key: string) => void;
  onToggleAll?: () => void;
}) {
  if (cards.length === 0) return null;
  const selectable = selected !== undefined && onToggle !== undefined;
  return (
    <div style={{ overflowX: "auto", ...style }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
        <thead>
          <tr style={{ textAlign: "left", color: "#94A3B8", fontSize: 12 }}>
            {selectable && (
              <th style={{ ...th, width: 34 }}>
                <input
                  type="checkbox"
                  aria-label="Select all"
                  checked={cards.length > 0 && cards.every((c) => selected.has(keyOf(c)))}
                  onChange={() => onToggleAll?.()}
                  style={checkbox}
                />
              </th>
            )}
            <th style={th}>PO</th>
            <th style={th}>Supplier</th>
            <th style={{ ...th, textAlign: "right" }}>Lines</th>
            <th style={th}>Requested</th>
            <th style={th}>Confirmed</th>
            <th style={th}>Status</th>
            <th style={th}>Key findings</th>
          </tr>
        </thead>
        <tbody>
          {cards.map((c) => {
            const alert = c.queue !== null;
            return (
              <tr
                key={`${c.poNumber}-${c.abId ?? "po"}`}
                onClick={() => onOpen(c)}
                style={{ borderTop: "1px solid #EEF1F6", cursor: "pointer" }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "#F8FAFC")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                {selectable && (
                  <td style={td} onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label={`Select PO ${c.poNumber}`}
                      checked={selected.has(keyOf(c))}
                      onChange={() => onToggle(keyOf(c))}
                      style={checkbox}
                    />
                  </td>
                )}
                <td style={{ ...td, fontWeight: 600 }}>
                  {c.poNumber}
                  {c.abNumber && <span style={{ color: "#94A3B8", fontWeight: 400 }}> · {c.abNumber}</span>}
                </td>
                <td style={td}>{c.supplier ?? "—"}</td>
                <td style={{ ...td, textAlign: "right" }}>
                  {c.lineCount > 0
                    ? c.deviatingCount > 0
                      ? `${c.deviatingCount} / ${c.lineCount}`
                      : c.lineCount
                    : "—"}
                </td>
                <td style={td}>{formatEn(c.requestedDate)}</td>
                <td style={td}>{formatEn(c.confirmedDate)}</td>
                <td style={td}><StatusPill status={c.status} /></td>
                <td style={{ ...td, color: alert ? "#0F172A" : "#64748B" }}>{c.keyFindings}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const th: React.CSSProperties = { padding: "8px 10px", fontWeight: 600 };
const td: React.CSSProperties = { padding: "12px 10px", verticalAlign: "middle" };
const select: React.CSSProperties = { border: "1px solid #E2E8F0", borderRadius: 8, padding: "7px 10px", fontSize: 13.5, background: "#fff", color: "#0F172A" };
const checkbox: React.CSSProperties = { width: 15, height: 15, cursor: "pointer", accentColor: "var(--primary)", display: "block" };
const bulkBtn: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer",
  border: "1px solid #C9C7FF", background: "#fff", color: "#0F172A",
  borderRadius: 8, padding: "6px 12px", fontSize: 13, fontWeight: 600,
};
