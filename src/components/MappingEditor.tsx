"use client";

import { useEffect, useState } from "react";
import { Loader2, Check } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Mapping {
  delimiter: string;
  decimal_sep: string;
  date_format: string;
  encoding: "utf-8" | "latin1";
  mapping: Record<string, string>;
}

const FIELD_LABELS: Record<string, string> = {
  po_number: "PO number",
  position: "Item / position",
  article: "Part / material",
  article_desc: "Short text",
  ordered_qty: "Quantity",
  unit_price: "Price",
  currency: "Currency",
  requested_date: "Requested date",
  po_date: "PO date",
  supplier: "Supplier",
  confirmed_date: "Confirmed (SAP)",
};

// Adjustable SAP column mapping — the one place a customer's export format is
// adapted (delimiter, decimals, dates, encoding, column names).
export default function MappingEditor() {
  const [mapping, setMapping] = useState<Mapping | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch("/api/settings/mapping").then((r) => r.json()).then(setMapping).catch(() => {});
  }, []);

  async function save() {
    if (!mapping) return;
    setSaving(true);
    setSaved(false);
    try {
      await fetch("/api/settings/mapping", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(mapping) });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } finally {
      setSaving(false);
    }
  }

  if (!mapping) return <Loader2 className="animate-spin" style={{ color: "var(--primary)" }} />;

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 12, marginBottom: 14 }}>
        <Field label="Delimiter" value={mapping.delimiter} onChange={(v) => setMapping({ ...mapping, delimiter: v })} />
        <Field label="Decimal" value={mapping.decimal_sep} onChange={(v) => setMapping({ ...mapping, decimal_sep: v })} />
        <Field label="Date format" value={mapping.date_format} onChange={(v) => setMapping({ ...mapping, date_format: v })} />
        <div>
          <label style={labelStyle}>Encoding</label>
          <select value={mapping.encoding} onChange={(e) => setMapping({ ...mapping, encoding: e.target.value as Mapping["encoding"] })} style={inputStyle}>
            <option value="latin1">Latin-1</option>
            <option value="utf-8">UTF-8</option>
          </select>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        {Object.keys(mapping.mapping).map((field) => (
          <div key={field}>
            <label style={labelStyle}>{FIELD_LABELS[field] ?? field}</label>
            <input value={mapping.mapping[field] ?? ""} onChange={(e) => setMapping({ ...mapping, mapping: { ...mapping.mapping, [field]: e.target.value } })} style={inputStyle} />
          </div>
        ))}
      </div>
      <div style={{ marginTop: 14 }}>
        <Button size="sm" onClick={save} disabled={saving}>
          {saving ? <Loader2 className="animate-spin" /> : saved ? <Check /> : null}
          {saved ? "Saved" : "Save mapping"}
        </Button>
      </div>
    </div>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label style={labelStyle}>{label}</label>
      <input value={value} onChange={(e) => onChange(e.target.value)} style={inputStyle} />
    </div>
  );
}

const labelStyle: React.CSSProperties = { display: "block", fontSize: 12, color: "#94A3B8", marginBottom: 4 };
const inputStyle: React.CSSProperties = { width: "100%", padding: "8px 10px", border: "1px solid #E2E8F0", borderRadius: 8, fontSize: 13.5, color: "#0F172A", background: "#FFFFFF" };
