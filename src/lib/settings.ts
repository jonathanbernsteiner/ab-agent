import "server-only";
import { getSupabase } from "@/lib/supabase";
import { getCompanyId } from "@/lib/tenant";
import { DEFAULT_MAPPING, type ColumnMapping } from "@/lib/sap/mapping";

// The active SAP column mapping. Stored per company so each customer's export can
// be adapted independently; falls back to DEFAULT_MAPPING if none saved.
export async function getActiveMapping(): Promise<ColumnMapping> {
  const sb = getSupabase();
  const { data } = await sb
    .from("column_mappings")
    .select("*")
    .eq("company_id", getCompanyId())
    .eq("is_active", true)
    .order("updated_at", { ascending: false })
    .limit(1);
  if (data && data.length) {
    const row = data[0];
    return {
      delimiter: row.delimiter ?? DEFAULT_MAPPING.delimiter,
      decimal_sep: row.decimal_sep ?? DEFAULT_MAPPING.decimal_sep,
      date_format: row.date_format ?? DEFAULT_MAPPING.date_format,
      encoding: (row.encoding as ColumnMapping["encoding"]) ?? DEFAULT_MAPPING.encoding,
      mapping: { ...DEFAULT_MAPPING.mapping, ...(row.mapping ?? {}) },
    };
  }
  return DEFAULT_MAPPING;
}

export async function saveMapping(m: ColumnMapping): Promise<void> {
  const sb = getSupabase();
  const cid = getCompanyId();
  await sb
    .from("column_mappings")
    .update({ is_active: false })
    .eq("company_id", cid)
    .eq("is_active", true);
  await sb.from("column_mappings").insert({
    company_id: cid,
    name: "default",
    delimiter: m.delimiter,
    decimal_sep: m.decimal_sep,
    date_format: m.date_format,
    encoding: m.encoding,
    mapping: m.mapping,
    is_active: true,
  });
}

// ── Deadlines (configurable overdue windows) ────────────────────────────────
export interface Deadlines {
  overdue_days: number;
  level2_days: number;
  escalation_days: number;
}

export const DEFAULT_DEADLINES: Deadlines = { overdue_days: 3, level2_days: 3, escalation_days: 3 };

// Deadlines live on the company row (single source of truth per tenant).
export async function getDeadlines(): Promise<Deadlines> {
  const sb = getSupabase();
  const { data } = await sb
    .from("companies")
    .select("overdue_days, level2_days, escalation_days")
    .eq("id", getCompanyId())
    .limit(1)
    .single();
  return {
    overdue_days: data?.overdue_days ?? DEFAULT_DEADLINES.overdue_days,
    level2_days: data?.level2_days ?? DEFAULT_DEADLINES.level2_days,
    escalation_days: data?.escalation_days ?? DEFAULT_DEADLINES.escalation_days,
  };
}

export async function saveDeadlines(d: Deadlines): Promise<void> {
  const sb = getSupabase();
  await sb
    .from("companies")
    .update({
      overdue_days: Math.max(0, Math.round(d.overdue_days)),
      level2_days: Math.max(0, Math.round(d.level2_days)),
      escalation_days: Math.max(0, Math.round(d.escalation_days)),
      updated_at: new Date().toISOString(),
    })
    .eq("id", getCompanyId());
}
