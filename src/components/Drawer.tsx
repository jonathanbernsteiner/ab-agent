"use client";

import { useCallback, useEffect, useState } from "react";
import {
  X, Check, Copy, Mail, AlarmClock, CheckCheck,
  ExternalLink, ChevronDown, Loader2, FileText, Package, Send,
} from "lucide-react";
import { StatusPill } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { buildPushback } from "@/lib/chaser";
import { formatEn, isoDateOf } from "@/lib/dates";
import type { DrawerData } from "@/lib/views";

export type DrawerEntry = { type: "ab"; id: string } | { type: "po"; id: string };

export default function Drawer({
  entry,
  onClose,
  onChanged,
  onNavigate,
}: {
  entry: DrawerEntry | null;
  onClose: () => void;
  onChanged: () => void;
  onNavigate: (e: DrawerEntry) => void;
}) {
  const [data, setData] = useState<DrawerData | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!entry) return;
    setLoading(true);
    try {
      const q = entry.type === "ab" ? `ab=${entry.id}` : `po=${encodeURIComponent(entry.id)}`;
      const res = await fetch(`/api/drawer?${q}`);
      setData(res.ok ? await res.json() : null);
    } finally {
      setLoading(false);
    }
  }, [entry]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (entry) load();
    else setData(null);
  }, [entry, load]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    if (entry) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [entry, onClose]);

  if (!entry) return null;

  async function refresh() {
    await load();
    onChanged();
  }

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.35)", zIndex: 60 }} />
      <aside
        style={{
          position: "fixed", top: 0, right: 0, bottom: 0, width: "min(600px, 96vw)",
          background: "#FFFFFF", zIndex: 61, boxShadow: "-8px 0 24px rgba(0,0,0,0.12)",
          display: "flex", flexDirection: "column",
        }}
      >
        {loading && !data ? (
          <div style={{ padding: 40, textAlign: "center" }}>
            <Loader2 className="animate-spin" style={{ color: "var(--primary)", margin: "0 auto" }} />
          </div>
        ) : data ? (
          <DrawerBody data={data} onClose={onClose} refresh={refresh} onNavigate={onNavigate} />
        ) : (
          <div style={{ padding: 40 }}>Not found.</div>
        )}
      </aside>
    </>
  );
}

function DrawerBody({
  data, onClose, refresh, onNavigate,
}: {
  data: DrawerData;
  onClose: () => void;
  refresh: () => Promise<void>;
  onNavigate: (e: DrawerEntry) => void;
}) {
  const [showExtraction, setShowExtraction] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const unresolved = data.lineItems.filter((l) => !l.resolved && l.bucket === "deviation");
  const requested = data.lineItems.find((l) => l.requestedDate)?.requestedDate ?? null;

  async function post(url: string, body: unknown, tag: string) {
    setBusy(tag);
    try {
      await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  async function copy(text: string, tag: string) {
    await navigator.clipboard.writeText(text);
    setCopied(tag);
    setTimeout(() => setCopied(null), 2000);
  }

  const pushbackDraft = buildPushback(
    { po_number: data.poNumber ?? "", supplier: data.supplier, requested_date: requested },
    unresolved.flatMap((l) => l.findings.map((f) => f.raw)),
    data.signature,
    data.supplierEmail ?? "",
  );

  return (
    <>
      {/* Header */}
      <div style={{ padding: "18px 22px", borderBottom: "1px solid #EEF1F6" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <StatusPill status={data.status} />
              <span style={{ fontSize: 16, fontWeight: 700 }}>{data.supplier ?? "Unknown supplier"}</span>
            </div>
            <div style={{ fontSize: 12.5, color: "#64748B", marginTop: 5 }}>
              {data.poNumber ? `PO ${data.poNumber}` : "No PO"}
              {data.abNumber ? ` · Confirmation ${data.abNumber}` : ""}
              {data.receivedAt ? ` · received ${formatEn(isoDateOf(data.receivedAt), true)}` : ""}
            </div>
          </div>
          <button aria-label="Close" onClick={onClose} style={{ background: "transparent", border: "none", cursor: "pointer", color: "#64748B" }}>
            <X size={18} />
          </button>
        </div>

        <div style={{ display: "flex", gap: 16, marginTop: 10, flexWrap: "wrap" }}>
          {data.entryType === "ab" && data.poNumber && (
            <button onClick={() => onNavigate({ type: "po", id: data.poNumber! })} style={linkBtn}>
              <Package size={13} /> belongs to PO {data.poNumber} →
            </button>
          )}
          {data.entryType === "po" && data.abId && (
            <button onClick={() => onNavigate({ type: "ab", id: data.abId! })} style={linkBtn}>
              <FileText size={13} /> view confirmation →
            </button>
          )}
          {data.originalUrl && (
            <a href={data.originalUrl} target="_blank" rel="noreferrer" style={{ ...linkBtn, textDecoration: "none" }}>
              <ExternalLink size={13} /> original document
            </a>
          )}
        </div>
      </div>

      {/* Scroll body */}
      <div style={{ flex: 1, overflow: "auto", padding: "18px 22px" }}>
        {data.context === "no_po" && (
          <div style={{ padding: 14, borderRadius: 8, background: "var(--warn-bg)", color: "#92400E", fontSize: 13.5, marginBottom: 18 }}>
            No purchase-order number matched — is this an order confirmation? The document is stored but not linked to a PO.
          </div>
        )}

        {/* Line items — one simple comparison table per position */}
        {data.lineItems.length > 0 && (
          <div style={{ marginBottom: 22 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <SectionTitle>Line items</SectionTitle>
              {unresolved.length > 1 && (
                <Button size="sm" onClick={() => post("/api/decisions", { abId: data.abId, kind: "accept_all" }, "accept_all")} disabled={busy !== null}>
                  {busy === "accept_all" ? <Loader2 className="animate-spin" /> : <Check />} Accept all ({unresolved.length})
                </Button>
              )}
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 10 }}>
              {data.lineItems.map((l, i) => (
                <LineItemCard
                  key={i}
                  l={l}
                  busy={busy}
                  onAccept={() =>
                    post("/api/decisions", { poNumber: data.poNumber, position: l.position, abId: data.abId, kind: "accept", confirmedDate: l.confirmedDate, confirmedQty: l.extractedQty, confirmedPrice: l.extractedPrice }, `accept-${l.position}`)
                  }
                />
              ))}
            </div>
          </div>
        )}

        {/* Push-back email — one message covering all open deviations */}
        {unresolved.length > 0 && (
          <div style={{ marginBottom: 22 }}>
            <SectionTitle>Push back to supplier</SectionTitle>
            <p style={{ fontSize: 12.5, color: "#64748B", margin: "6px 0 8px" }}>
              {data.canSendEmail
                ? "Ask the supplier to fix the deviations above. Review the draft, then send it from your connected mailbox — it replies on the original email thread."
                : "Ask the supplier to fix the deviations above. Nothing is sent automatically — copy it or open it in your mail client."}
            </p>
            <EmailComposer
              draft={pushbackDraft}
              tag="pushback"
              copy={copy}
              copied={copied}
              canSend={data.canSendEmail}
              abId={data.abId}
              sendMeta={{ kind: "pushback", poNumber: data.poNumber, supplier: data.supplier }}
              onSent={() => refresh()}
            />
          </div>
        )}

        {/* Overdue chaser */}
        {data.overdue && (
          <OverdueBlock data={data} post={post} copy={copy} copied={copied} busy={busy} refresh={refresh} />
        )}

        {/* What the agent read */}
        {data.extraction != null && (
          <div style={{ marginBottom: 22 }}>
            <button onClick={() => setShowExtraction((s) => !s)} style={{ ...linkBtn, fontSize: 13, fontWeight: 600, color: "#0F172A" }}>
              <ChevronDown size={14} style={{ transform: showExtraction ? "rotate(180deg)" : "none", transition: "transform .15s" }} /> What the agent read from the document
            </button>
            {showExtraction && <pre style={preStyle}>{JSON.stringify(data.extraction, null, 2)}</pre>}
          </div>
        )}

        {/* Timeline */}
        <div>
          <SectionTitle>Timeline</SectionTitle>
          <ul style={{ margin: "8px 0 0", padding: 0, listStyle: "none" }}>
            {data.timeline.map((t, i) => (
              <li key={i} style={{ display: "flex", gap: 10, padding: "6px 0", fontSize: 13 }}>
                <span style={{ color: "#94A3B8", minWidth: 96, fontSize: 12 }}>{formatEn(isoDateOf(t.at), true)}</span>
                <span style={{ color: "#334155" }}>{t.label}</span>
              </li>
            ))}
            {data.timeline.length === 0 && <li style={{ fontSize: 13, color: "#94A3B8" }}>No events yet.</li>}
          </ul>
        </div>
      </div>
    </>
  );
}

// One position as a plain 3-column comparison table (Field · Ordered · Confirmed).
function LineItemCard({
  l, busy, onAccept,
}: {
  l: DrawerData["lineItems"][number];
  busy: string | null;
  onAccept: () => void;
}) {
  const deviating = !l.resolved && l.bucket === "deviation";
  const rows: { field: string; ordered: string; confirmed: string; diff: boolean }[] = [
    { field: "Quantity", ordered: numOr(l.orderedQty), confirmed: numOr(l.extractedQty), diff: l.orderedQty != null && l.extractedQty != null && l.orderedQty !== l.extractedQty },
    { field: "Unit price", ordered: money(l.unitPrice), confirmed: money(l.extractedPrice), diff: l.unitPrice != null && l.extractedPrice != null && Math.abs(l.unitPrice - l.extractedPrice) > 0.001 },
    { field: "Delivery", ordered: formatEn(l.requestedDate), confirmed: formatEn(l.confirmedDate), diff: !!l.requestedDate && !!l.confirmedDate && l.requestedDate !== l.confirmedDate },
  ];

  return (
    <div style={{ border: "1px solid #E2E8F0", borderRadius: 10, overflow: "hidden" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: "10px 14px", background: "#F8FAFC", borderBottom: "1px solid #EEF1F6" }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>Item {l.position}{l.article ? ` · ${l.article}` : ""}</span>
        <StatusPill status={l.resolved ? "confirmed" : l.bucket === "deviation" ? "deviation" : "match"} />
      </div>

      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ color: "#94A3B8", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4 }}>
            <th style={{ ...td, textAlign: "left", fontWeight: 600 }}>Field</th>
            <th style={{ ...td, textAlign: "left", fontWeight: 600 }}>Ordered (PO)</th>
            <th style={{ ...td, textAlign: "left", fontWeight: 600 }}>Confirmed (AB)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.field}>
              <td style={{ ...td, color: "#64748B" }}>{r.field}</td>
              <td style={td}>{r.ordered}</td>
              <td style={{ ...td, fontWeight: r.diff ? 700 : 400, color: r.diff ? "var(--warn, #B45309)" : "#0F172A", background: r.diff ? "var(--warn-bg, #FEF3C7)" : "transparent" }}>
                {r.confirmed}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {l.findings.length > 0 && (
        <div style={{ padding: "8px 14px", borderTop: "1px solid #EEF1F6", display: "flex", flexWrap: "wrap", gap: "4px 12px" }}>
          {l.findings.map((f, j) => (
            <span key={j} style={{ fontSize: 12.5, color: l.resolved ? "#64748B" : "var(--warn, #B45309)" }}>• {f.label}</span>
          ))}
        </div>
      )}

      {deviating && (
        <div style={{ padding: "10px 14px", borderTop: "1px solid #EEF1F6" }}>
          <Button size="sm" onClick={onAccept} disabled={busy !== null}>
            {busy === `accept-${l.position}` ? <Loader2 className="animate-spin" /> : <Check />} Accept confirmation
          </Button>
        </div>
      )}
    </div>
  );
}

// Editable To / Subject / Body with Copy + Open-in-mail, plus a real Send button
// when a Gmail mailbox is connected. Used for pushback and chaser. sendMeta
// travels with the send so the server can advance the flow (log the pushback,
// snooze + escalate the chaser, remember the contact); onMarkSent covers the
// copy/mail-client path where we can't observe the send.
function EmailComposer({
  draft, tag, copy, copied, canSend, abId, sendMeta, onSent, onMarkSent, children,
}: {
  draft: { to: string; subject: string; body: string };
  tag: string;
  copy: (text: string, tag: string) => void;
  copied: string | null;
  canSend?: boolean;
  abId?: string | null;
  sendMeta?: Record<string, unknown>;
  onSent?: () => void;
  onMarkSent?: (to: string) => void;
  children?: React.ReactNode;
}) {
  const [to, setTo] = useState(draft.to);
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const [sendState, setSendState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [sendError, setSendError] = useState<string | null>(null);

  const mailto = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  const full = `To: ${to}\nSubject: ${subject}\n\n${body}`;

  async function send() {
    setSendState("sending");
    setSendError(null);
    try {
      const res = await fetch("/api/mail/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to, subject, body, abId: abId ?? null, ...(sendMeta ?? {}) }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error || "Send failed.");
      setSendState("sent");
      onSent?.();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Send failed.");
      setSendState("error");
    }
  }

  return (
    <div style={{ marginTop: 8 }}>
      <label style={fieldLabel}>To</label>
      <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="supplier@example.com" style={inputStyle} />
      <label style={fieldLabel}>Subject</label>
      <input value={subject} onChange={(e) => setSubject(e.target.value)} style={{ ...inputStyle, fontWeight: 600 }} />
      <label style={fieldLabel}>Message</label>
      <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={9} style={{ ...inputStyle, resize: "vertical", fontFamily: "var(--font-jetbrains-mono), monospace", fontSize: 12.5 }} />
      <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap", position: "relative" }}>
        {canSend && (
          <Button size="sm" onClick={send} disabled={sendState === "sending" || sendState === "sent" || !to.trim()}>
            {sendState === "sending" ? <Loader2 className="animate-spin" /> : sendState === "sent" ? <Check /> : <Send />}
            {sendState === "sent" ? "Sent" : "Send email"}
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={() => copy(full, tag)}>
          {copied === tag ? <Check /> : <Copy />} {copied === tag ? "Copied" : "Copy email"}
        </Button>
        <Button size="sm" variant={canSend ? "outline" : "default"} asChild><a href={mailto}><Mail /> Open in mail client</a></Button>
        {onMarkSent && (
          <Button size="sm" variant="outline" onClick={() => onMarkSent(to)}>
            <CheckCheck /> Mark as sent
          </Button>
        )}
        {children}
      </div>
      {sendError && <p style={{ fontSize: 12.5, color: "#DC2626", margin: "8px 0 0" }}>{sendError}</p>}
    </div>
  );
}

function OverdueBlock({
  data, post, copy, copied, busy, refresh,
}: {
  data: DrawerData;
  post: (url: string, body: unknown, tag: string) => Promise<void>;
  copy: (text: string, tag: string) => void;
  copied: string | null;
  busy: string | null;
  refresh: () => Promise<void>;
}) {
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  // Level 3 = internal escalation: the mail goes to a colleague (PO owner /
  // manager), not the supplier — so no prefilled supplier address, and the
  // recipient is never learned as a supplier contact (supplier: null).
  const escalation = data.overdue!.level === 3;
  const draft = {
    to: escalation ? "" : data.supplierEmail ?? "",
    subject: data.overdue!.chaser.subject,
    body: data.overdue!.chaser.body,
  };

  return (
    <div style={{ marginBottom: 22 }}>
      <SectionTitle>
        {escalation ? (
          <>Escalation draft <span style={{ color: "var(--overdue)" }}>· internal (level 3)</span></>
        ) : (
          <>Chaser draft {data.overdue!.level === 2 && <span style={{ color: "var(--overdue)" }}>· level 2 (with deadline)</span>}</>
        )}
      </SectionTitle>
      <p style={{ fontSize: 12.5, color: "#64748B", margin: "6px 0 0" }}>
        {escalation ? (
          <>
            Two reminders went unanswered — no confirmation for {data.overdue!.businessDaysWaiting} business days.
            Forward this to the PO owner or your manager (it goes to a colleague, not the supplier). Sending or
            marking it sent hides the PO for {data.overdue!.followUpDays} business day
            {data.overdue!.followUpDays === 1 ? "" : "s"}. Or snooze / resolve.
          </>
        ) : (
          <>
            No confirmation for {data.overdue!.businessDaysWaiting} business days. Send the reminder (or mark it sent if
            you mailed it yourself) — if the supplier stays silent it resurfaces escalated after{" "}
            {data.overdue!.followUpDays} business day{data.overdue!.followUpDays === 1 ? "" : "s"}. Or snooze / resolve.
          </>
        )}
      </p>
      <EmailComposer
        draft={draft}
        tag="chaser"
        copy={copy}
        copied={copied}
        canSend={data.canSendEmail}
        sendMeta={{ kind: "chaser", poNumber: data.poNumber, supplier: escalation ? null : data.supplier, level: data.overdue!.level }}
        onSent={() => refresh()}
        onMarkSent={(to) =>
          post(
            "/api/chasers",
            { poNumber: data.poNumber, action: "sent", level: data.overdue!.level, to, supplier: escalation ? null : data.supplier },
            "sent",
          )
        }
      >
        <div style={{ position: "relative" }}>
          <Button size="sm" variant="outline" onClick={() => setSnoozeOpen((s) => !s)} disabled={busy !== null}>
            <AlarmClock /> Snooze <ChevronDown size={13} />
          </Button>
          {snoozeOpen && (
            <div style={{ position: "absolute", top: "100%", left: 0, marginTop: 4, background: "#fff", border: "1px solid #E2E8F0", borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.1)", zIndex: 5, minWidth: 140 }}>
              {[1, 2, 5].map((d) => (
                <button key={d} onClick={() => { setSnoozeOpen(false); post("/api/chasers", { poNumber: data.poNumber, action: "snooze", days: d }, "snooze"); }} style={menuItem}>
                  {d} day{d > 1 ? "s" : ""}
                </button>
              ))}
              <label style={{ ...menuItem, display: "block", cursor: "default" }}>
                Custom date
                <input type="date" onChange={(e) => { if (e.target.value) { setSnoozeOpen(false); post("/api/chasers", { poNumber: data.poNumber, action: "snooze", until: e.target.value }, "snooze"); } }} style={{ ...inputStyle, marginTop: 4 }} />
              </label>
            </div>
          )}
        </div>
        <Button size="sm" variant="ghost" onClick={() => post("/api/chasers", { poNumber: data.poNumber, action: "resolve" }, "resolve")} disabled={busy !== null}>
          {busy === "resolve" ? <Loader2 className="animate-spin" /> : <CheckCheck />} Resolve
        </Button>
      </EmailComposer>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12, fontWeight: 700, color: "#94A3B8", textTransform: "uppercase", letterSpacing: 0.6 }}>{children}</div>;
}
function money(n: number | null): string {
  return n == null ? "–" : `€${n.toFixed(2)}`;
}
function numOr(n: number | null): string {
  return n == null ? "–" : String(n);
}

const linkBtn: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 5, background: "transparent", border: "none", cursor: "pointer", color: "var(--primary)", fontSize: 12.5, padding: 0 };
const inputStyle: React.CSSProperties = { width: "100%", padding: "8px 10px", border: "1px solid #E2E8F0", borderRadius: 8, fontSize: 13.5, color: "#0F172A", background: "#FFFFFF", boxSizing: "border-box", marginTop: 4 };
const fieldLabel: React.CSSProperties = { display: "block", fontSize: 11, fontWeight: 600, color: "#94A3B8", marginTop: 10, textTransform: "uppercase", letterSpacing: 0.4 };
const preStyle: React.CSSProperties = { marginTop: 10, padding: 14, background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 8, fontSize: 12, fontFamily: "var(--font-jetbrains-mono), monospace", whiteSpace: "pre-wrap", color: "#334155", maxHeight: 320, overflow: "auto" };
const menuItem: React.CSSProperties = { display: "block", width: "100%", textAlign: "left", padding: "8px 12px", background: "transparent", border: "none", cursor: "pointer", fontSize: 13, color: "#334155" };
const td: React.CSSProperties = { padding: "7px 14px", borderBottom: "1px solid #F1F5F9", textAlign: "left" };
