"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { UploadCloud, Download, Loader2, ChevronDown, FileText, CheckCircle2, XCircle } from "lucide-react";
import { Panel, StatusPill } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import MappingEditor from "@/components/MappingEditor";
import { formatEn, isoDateOf } from "@/lib/dates";
import type { ExportRow } from "@/lib/sap/export";
import type { HistoryRow } from "@/lib/store";

interface ImportSummary {
  inserted: number; updated: number; archived: number;
  confirmedBySap: number; externallyChanged: number; warnings?: string[]; error?: string;
}

interface SampleRow {
  po_number: string; position: number; article: string | null;
  ordered_qty: number | null; unit_price: number | null; currency: string;
  requested_date: string | null; supplier: string | null; confirmed_date: string | null;
}

interface ImportPreview {
  filename: string;
  totalLines: number; poCount: number; supplierCount: number; confirmedCount: number;
  skippedJunk: number; warnings?: string[];
  profile: { delimiter: string | null; decimal_sep: string; encoding: string | null; columns: Record<string, string | null> };
  sample: SampleRow[];
}

const FIELD_LABELS: [string, string][] = [
  ["po_number", "PO number"], ["position", "Item"], ["article", "Article"],
  ["article_desc", "Description"], ["ordered_qty", "Quantity"], ["unit_price", "Unit price"],
  ["currency", "Currency"], ["requested_date", "Requested date"], ["po_date", "PO date"],
  ["supplier", "Supplier"], ["confirmed_date", "Confirmed date"],
];

interface AbResult {
  filename: string;
  deduped?: boolean;
  docKind?: string;
  bucket?: string;
  poNumber?: string | null;
  supplier?: string | null;
  message?: string;
  error?: string;
}

type Tab = "slp" | "ab" | "export";

const TABS: { key: Tab; label: string }[] = [
  { key: "slp", label: "Import SLP" },
  { key: "ab", label: "Import AB Confirmation" },
  { key: "export", label: "Export" },
];

export default function ImportExportClient({
  exportRows, importHistory, exportHistory, intakeEmail,
}: {
  exportRows: ExportRow[];
  importHistory: HistoryRow[];
  exportHistory: HistoryRow[];
  intakeEmail: string;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("slp");

  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [showMapping, setShowMapping] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [importError, setImportError] = useState<{ error: string; warnings?: string[] } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const [abResults, setAbResults] = useState<AbResult[] | null>(null);
  const [abBusy, setAbBusy] = useState(false);
  const [abDrag, setAbDrag] = useState(false);
  const abInputRef = useRef<HTMLInputElement>(null);

  // Step 1: upload + profile. Parses the file server-side without importing,
  // so the user can check what was detected before committing.
  async function profileFile(file: File) {
    setBusy(true);
    setSummary(null);
    setPreview(null);
    setPendingFile(null);
    setImportError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/import/preview", { method: "POST", body: fd });
      const data = await res.json();
      if (res.ok) {
        setPreview(data);
        setPendingFile(file);
      } else {
        setImportError({ error: data.error ?? "Could not read the file.", warnings: data.warnings });
      }
    } catch {
      setImportError({ error: "Could not read the file." });
    } finally {
      setBusy(false);
    }
  }

  // Step 2: confirm. Re-sends the held file to the real import endpoint.
  async function confirmImport() {
    if (!pendingFile) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", pendingFile);
      const res = await fetch("/api/import", { method: "POST", body: fd });
      const data = await res.json();
      if (res.ok) {
        setSummary(data);
        setPreview(null);
        setPendingFile(null);
      } else {
        setImportError({ error: data.error ?? "Import failed.", warnings: data.warnings });
      }
      router.refresh();
    } catch {
      setImportError({ error: "Import failed." });
    } finally {
      setBusy(false);
    }
  }

  function cancelPreview() {
    setPreview(null);
    setPendingFile(null);
    setImportError(null);
  }

  async function uploadAb(files: File[]) {
    if (files.length === 0) return;
    setAbBusy(true);
    setAbResults(null);
    try {
      const fd = new FormData();
      files.forEach((f) => fd.append("file", f));
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      const data = await res.json();
      setAbResults(Array.isArray(data.results) ? data.results : []);
      router.refresh();
    } catch {
      setAbResults([{ filename: files[0]?.name ?? "file", error: "Upload failed." }]);
    } finally {
      setAbBusy(false);
    }
  }

  function exportNow(format?: "xlsx") {
    const a = document.createElement("a");
    a.href = format === "xlsx" ? "/api/export?format=xlsx" : "/api/export";
    a.download = "";
    a.click();
    setTimeout(() => router.refresh(), 1500);
  }

  return (
    <div style={{ padding: 32, maxWidth: 1080 }}>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Import / Export</h2>
        <p style={{ color: "#64748B", fontSize: 14, marginTop: 4 }}>Morning: import the SAP PO list. Evening: export confirmed dates back to SAP.</p>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 4, borderBottom: "1px solid #E2E8F0" }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              padding: "10px 14px", background: "transparent", border: "none", cursor: "pointer",
              fontSize: 14, fontWeight: tab === t.key ? 700 : 500,
              color: tab === t.key ? "#0F172A" : "#64748B",
              borderBottom: tab === t.key ? "2px solid var(--primary)" : "2px solid transparent",
              marginBottom: -1,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div style={{ marginTop: 20 }}>
        {/* ── Import SLP (SAP order list) ─────────────────────────── */}
        {tab === "slp" && (
          <>
            <Panel style={{ padding: 20 }}>
              <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0, marginBottom: 2 }}>Import SAP order list</h3>
              <p style={{ fontSize: 12.5, color: "#64748B", margin: "0 0 12px" }}>Drop your SAP PO export — CSV or Excel, German or English format. You&apos;ll see a preview before anything is imported.</p>

              {!preview && (
                <div
                  onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
                  onDragLeave={() => setDrag(false)}
                  onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) profileFile(f); }}
                  onClick={() => inputRef.current?.click()}
                  style={{ border: `2px dashed ${drag ? "var(--primary)" : "#CBD5E1"}`, background: drag ? "var(--accent)" : "#fff", borderRadius: 10, padding: 28, textAlign: "center", cursor: "pointer" }}
                >
                  <input ref={inputRef} type="file" accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) profileFile(f); e.target.value = ""; }} />
                  {busy ? <Loader2 className="animate-spin" style={{ margin: "0 auto", color: "var(--primary)" }} /> : <UploadCloud size={24} style={{ margin: "0 auto", color: "var(--primary)" }} />}
                  <div style={{ fontSize: 13.5, marginTop: 8, color: "#334155" }}>{busy ? "Reading the file…" : "Drop the SAP export here (CSV or Excel)"}</div>
                </div>
              )}

              {importError && (
                <div style={{ marginTop: 14 }}>
                  <div style={{ color: "var(--overdue)", fontSize: 13.5, display: "flex", alignItems: "center", gap: 6 }}>
                    <XCircle size={15} /> {importError.error}
                  </div>
                  {importError.warnings && importError.warnings.length > 0 && (
                    <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 12.5, color: "#94A3B8" }}>
                      {importError.warnings.map((w, i) => <li key={i}>{w}</li>)}
                    </ul>
                  )}
                </div>
              )}

              {preview && (
                <ImportPreviewCard
                  preview={preview}
                  busy={busy}
                  onConfirm={confirmImport}
                  onCancel={cancelPreview}
                />
              )}

              {summary && !summary.error && (
                <div style={{ marginTop: 14 }}>
                  <div style={{ fontSize: 13.5, color: "#0F172A", display: "flex", alignItems: "center", gap: 6 }}>
                    <CheckCircle2 size={15} style={{ color: "var(--primary)" }} />
                    Imported: {summary.inserted + summary.updated} lines · {summary.inserted} new · {summary.archived} closed
                    {summary.confirmedBySap ? ` · ${summary.confirmedBySap} confirmed via SAP` : ""}
                    {summary.externallyChanged ? ` · ${summary.externallyChanged} externally changed` : ""}
                  </div>
                  {summary.warnings && summary.warnings.length > 0 && (
                    <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 12.5, color: "#94A3B8" }}>
                      {summary.warnings.map((w, i) => <li key={i}>{w}</li>)}
                    </ul>
                  )}
                </div>
              )}

              <button onClick={() => setShowMapping((s) => !s)} style={{ marginTop: 16, display: "inline-flex", alignItems: "center", gap: 6, background: "transparent", border: "none", cursor: "pointer", color: "var(--primary)", fontSize: 13 }}>
                <ChevronDown size={14} style={{ transform: showMapping ? "rotate(180deg)" : "none", transition: "transform .15s" }} /> Column mapping
              </button>
              {showMapping && <div style={{ marginTop: 12 }}><MappingEditor /></div>}
            </Panel>

            <div style={{ marginTop: 18 }}>
              <HistoryList title="Import history" rows={importHistory} />
            </div>
          </>
        )}

        {/* ── Import AB Confirmation ──────────────────────────────── */}
        {tab === "ab" && (
          <Panel style={{ padding: 20 }}>
            <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0, marginBottom: 2 }}>Import a confirmation (AB)</h3>
            <p style={{ fontSize: 12.5, color: "#64748B", margin: "0 0 12px" }}>Drop a supplier order confirmation (PDF).</p>
            <div
              onDragOver={(e) => { e.preventDefault(); setAbDrag(true); }}
              onDragLeave={() => setAbDrag(false)}
              onDrop={(e) => { e.preventDefault(); setAbDrag(false); uploadAb(Array.from(e.dataTransfer.files)); }}
              onClick={() => abInputRef.current?.click()}
              style={{ border: `2px dashed ${abDrag ? "var(--primary)" : "#CBD5E1"}`, background: abDrag ? "var(--accent)" : "#fff", borderRadius: 10, padding: 28, textAlign: "center", cursor: "pointer" }}
            >
              <input ref={abInputRef} type="file" accept=".pdf,application/pdf" multiple style={{ display: "none" }} onChange={(e) => uploadAb(Array.from(e.target.files ?? []))} />
              {abBusy ? <Loader2 className="animate-spin" style={{ margin: "0 auto", color: "var(--primary)" }} /> : <UploadCloud size={24} style={{ margin: "0 auto", color: "var(--primary)" }} />}
              <div style={{ fontSize: 13.5, marginTop: 8, color: "#334155" }}>Drop the confirmation PDF here</div>
            </div>

            {abResults && (
              <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 8 }}>
                {abResults.length === 0 && <div style={{ fontSize: 13, color: "#94A3B8" }}>No results.</div>}
                {abResults.map((r, i) => (
                  <div key={i} style={{ fontSize: 12.5, color: r.error ? "var(--overdue)" : "#0F172A", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <StatusPill status={r.bucket ?? "pending"} />
                    <span style={{ fontWeight: 600 }}>{r.supplier ?? "—"}</span>
                    <span style={{ color: "#64748B" }}>PO {r.poNumber ?? "—"}</span>
                    <span style={{ color: r.error ? "var(--overdue)" : "#64748B" }}>· {r.error ?? r.message ?? ""}</span>
                  </div>
                ))}
              </div>
            )}

            <div style={{ marginTop: 14, fontSize: 12.5, color: "#94A3B8" }}>
              Or forward confirmations by email to:{" "}
              <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", color: "#334155" }}>{intakeEmail}</span>
            </div>
          </Panel>
        )}

        {/* ── Export ──────────────────────────────────────────────── */}
        {tab === "export" && (
          <>
            <Panel style={{ padding: 20 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>Export confirmations</h3>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <Button onClick={() => exportNow()} disabled={exportRows.length === 0}><Download /> Export CSV</Button>
                  <Button variant="outline" onClick={() => exportNow("xlsx")} disabled={exportRows.length === 0}><Download /> Export Excel</Button>
                </div>
              </div>
              <div style={{ fontSize: 12.5, color: "#94A3B8", marginBottom: 8 }}>{exportRows.length} confirmation(s) queued</div>
              <div style={{ maxHeight: 320, overflow: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                  <thead><tr style={{ textAlign: "left", color: "#94A3B8" }}>
                    <th style={th}>PO</th><th style={th}>Item</th><th style={th}>Date</th><th style={th}>Source</th>
                  </tr></thead>
                  <tbody>
                    {exportRows.map((r, i) => (
                      <tr key={i} style={{ borderTop: "1px solid #EEF1F6" }}>
                        <td style={td}>{r.po_number}</td>
                        <td style={td}>{r.position}</td>
                        <td style={td}>{formatEn(r.confirmed_date)}</td>
                        <td style={td}>{r.source === "auto" ? "Auto" : "Approved"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {exportRows.length === 0 && <div style={{ padding: 24, textAlign: "center", color: "#94A3B8", fontSize: 13 }}>Nothing queued yet.</div>}
              </div>
            </Panel>

            <div style={{ marginTop: 18 }}>
              <HistoryList title="Export history" rows={exportHistory} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Step 2 of the SLP import: the parsed profile of the uploaded file, shown for
// confirmation before anything is written.
function ImportPreviewCard({
  preview, busy, onConfirm, onCancel,
}: {
  preview: ImportPreview;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { profile } = preview;
  const delimiterLabel =
    profile.delimiter === null ? "Excel" :
    profile.delimiter === "\t" ? "Tab" :
    `“${profile.delimiter}”`;
  const decimalLabel = profile.decimal_sep === "," ? "Comma (German)" : "Point (English)";

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <FileText size={16} style={{ color: "var(--primary)" }} />
        <span style={{ fontSize: 13.5, fontWeight: 600 }}>{preview.filename}</span>
        <span style={{ fontSize: 12.5, color: "#64748B" }}>
          {preview.totalLines} lines · {preview.poCount} POs · {preview.supplierCount} suppliers
          {preview.confirmedCount ? ` · ${preview.confirmedCount} already confirmed in SAP` : ""}
        </span>
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
        <FormatChip label="Delimiter" value={delimiterLabel} />
        <FormatChip label="Decimals" value={decimalLabel} />
        {profile.encoding && <FormatChip label="Encoding" value={profile.encoding.toUpperCase()} />}
        {preview.skippedJunk > 0 && <FormatChip label="Skipped header junk" value={`${preview.skippedJunk} row(s)`} />}
      </div>

      <div style={{ marginTop: 12, fontSize: 12, color: "#94A3B8", fontWeight: 600 }}>Detected columns</div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
        {FIELD_LABELS.map(([field, label]) => {
          const header = profile.columns[field];
          return (
            <span key={field} style={{
              fontSize: 12, padding: "3px 8px", borderRadius: 6,
              border: "1px solid #E2E8F0",
              background: header ? "#fff" : "#F8FAFC",
              color: header ? "#334155" : "#94A3B8",
            }}>
              {label}{header ? <> ← <span style={{ fontWeight: 600 }}>{header}</span></> : " — not found"}
            </span>
          );
        })}
      </div>

      <div style={{ marginTop: 12, fontSize: 12, color: "#94A3B8", fontWeight: 600 }}>Preview (first {preview.sample.length} lines)</div>
      <div style={{ marginTop: 6, border: "1px solid #E2E8F0", borderRadius: 8, overflow: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <thead><tr style={{ textAlign: "left", color: "#94A3B8", background: "#F8FAFC" }}>
            <th style={th}>PO</th><th style={th}>Item</th><th style={th}>Article</th>
            <th style={th}>Qty</th><th style={th}>Price</th><th style={th}>Requested</th><th style={th}>Supplier</th>
          </tr></thead>
          <tbody>
            {preview.sample.map((r, i) => (
              <tr key={i} style={{ borderTop: "1px solid #EEF1F6" }}>
                <td style={td}>{r.po_number}</td>
                <td style={td}>{r.position}</td>
                <td style={td}>{r.article ?? "—"}</td>
                <td style={td}>{r.ordered_qty ?? "—"}</td>
                <td style={td}>{r.unit_price != null ? `${r.unit_price.toFixed(2)} ${r.currency}` : "—"}</td>
                <td style={td}>{r.requested_date ? formatEn(r.requested_date) : "—"}</td>
                <td style={td}>{r.supplier ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {preview.warnings && preview.warnings.length > 0 && (
        <ul style={{ margin: "10px 0 0", paddingLeft: 18, fontSize: 12.5, color: "#B45309" }}>
          {preview.warnings.map((w, i) => <li key={i}>{w}</li>)}
        </ul>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <Button onClick={onConfirm} disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <CheckCircle2 />} Confirm import ({preview.totalLines} lines)
        </Button>
        <Button variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </div>
  );
}

function FormatChip({ label, value }: { label: string; value: string }) {
  return (
    <span style={{ fontSize: 12, padding: "3px 8px", borderRadius: 6, border: "1px solid #E2E8F0", background: "#F8FAFC", color: "#64748B" }}>
      {label}: <span style={{ color: "#0F172A", fontWeight: 600 }}>{value}</span>
    </span>
  );
}

function HistoryList({ title, rows }: { title: string; rows: HistoryRow[] }) {
  return (
    <Panel style={{ padding: 20 }}>
      <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0, marginBottom: 10, color: "#64748B" }}>{title}</h3>
      {rows.length === 0 ? (
        <div style={{ fontSize: 13, color: "#94A3B8" }}>No history yet.</div>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
          {rows.map((r) => (
            <li key={r.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderTop: "1px solid #F1F5F9", fontSize: 13 }}>
              <FileText size={14} style={{ color: "#94A3B8" }} />
              <span style={{ flex: 1 }}>{r.filename ?? "—"}</span>
              <span style={{ color: "#94A3B8", fontSize: 12 }}>
                {Object.entries(r.counts).map(([k, v]) => `${v} ${k}`).join(" · ")} · {formatEn(isoDateOf(r.created_at), true)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

const th: React.CSSProperties = { padding: "6px 8px", fontWeight: 600 };
const td: React.CSSProperties = { padding: "7px 8px" };
