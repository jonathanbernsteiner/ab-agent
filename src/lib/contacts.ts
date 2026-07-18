import "server-only";
import { getSupabase } from "@/lib/supabase";
import { getCompanyId } from "@/lib/tenant";

// Supplier contacts: who to email at each supplier. Learned automatically from
// inbound confirmation emails and from addresses the user sends chasers /
// pushbacks to; editable in Settings → Contacts.

export interface SupplierContact {
  id: string;
  supplier: string;
  name: string | null;
  email: string;
  is_default: boolean;
  source: "inbound" | "outbound" | "manual";
  created_at: string;
}

// Normalized lookup key so the AB's letterhead name ("FEDERN VOGEL KG") and the
// SAP vendor name ("Federn Vogel") resolve to the same contact list: lowercase,
// legal-form suffixes stripped, non-alphanumerics dropped.
export function supplierKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(gmbh|mbh|ag|kg|ohg|ug|se|e\.?\s?k\.?|co|&|und|inc|ltd)\b\.?/g, " ")
    .replace(/[^a-z0-9äöüß]+/g, "")
    .trim();
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// Pull the bare address out of a From header ("Anna Huber <anna@vogel.de>").
export function emailAddressOf(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.match(/[^\s<>@,;"]+@[^\s<>@,;"]+/);
  return m ? m[0] : null;
}

// Pull the display name out of a From header, if any.
export function displayNameOf(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.match(/^\s*"?([^"<]+?)"?\s*</);
  return m ? m[1].trim() : null;
}

export interface LearnArgs {
  supplier: string | null | undefined;
  email: string | null | undefined;
  name?: string | null;
  source: "inbound" | "outbound" | "manual";
}

// Idempotent: creates the contact if this (supplier, email) pair is new, and
// makes the supplier's first-ever contact the default. Never overwrites a
// manual edit — an existing row only gains a name if it had none.
export async function learnContact(args: LearnArgs): Promise<void> {
  const supplier = args.supplier?.trim();
  const email = args.email ? normalizeEmail(args.email) : "";
  if (!supplier || !email || !email.includes("@")) return;

  const sb = getSupabase();
  const cid = getCompanyId();
  const key = supplierKey(supplier);
  if (!key) return;

  const { data: existing } = await sb
    .from("supplier_contacts")
    .select("id, email, name")
    .eq("company_id", cid)
    .eq("supplier_key", key);
  const rows = (existing ?? []) as { id: string; email: string; name: string | null }[];

  const match = rows.find((r) => r.email === email);
  if (match) {
    if (!match.name && args.name?.trim()) {
      await sb
        .from("supplier_contacts")
        .update({ name: args.name.trim(), updated_at: new Date().toISOString() })
        .eq("id", match.id);
    }
    return;
  }

  await sb.from("supplier_contacts").insert({
    company_id: cid,
    supplier,
    supplier_key: key,
    name: args.name?.trim() || null,
    email,
    is_default: rows.length === 0,
    source: args.source,
  });
}

// The address a chaser/pushback should default to: the supplier's default
// contact, else the newest one.
export async function getDefaultContact(
  supplier: string | null | undefined,
): Promise<SupplierContact | null> {
  if (!supplier?.trim()) return null;
  const sb = getSupabase();
  const { data } = await sb
    .from("supplier_contacts")
    .select("*")
    .eq("company_id", getCompanyId())
    .eq("supplier_key", supplierKey(supplier))
    .order("created_at", { ascending: false });
  const rows = (data ?? []) as SupplierContact[];
  if (rows.length === 0) return null;
  return rows.find((r) => r.is_default) ?? rows[0];
}

export async function listContacts(): Promise<SupplierContact[]> {
  const sb = getSupabase();
  const { data } = await sb
    .from("supplier_contacts")
    .select("*")
    .eq("company_id", getCompanyId())
    .order("created_at", { ascending: false });
  const rows = (data ?? []) as SupplierContact[];
  return rows.sort(
    (a, b) => a.supplier.localeCompare(b.supplier) || Number(b.is_default) - Number(a.is_default),
  );
}

export async function addContact(args: {
  supplier: string;
  email: string;
  name?: string | null;
}): Promise<void> {
  await learnContact({ ...args, source: "manual" });
}

export async function deleteContact(id: string): Promise<void> {
  const sb = getSupabase();
  await sb.from("supplier_contacts").delete().eq("company_id", getCompanyId()).eq("id", id);
}

// Exactly one default per supplier: clear the group, then set the winner.
export async function setDefaultContact(id: string): Promise<void> {
  const sb = getSupabase();
  const cid = getCompanyId();
  const { data } = await sb
    .from("supplier_contacts")
    .select("supplier_key")
    .eq("company_id", cid)
    .eq("id", id)
    .limit(1)
    .single();
  if (!data) return;
  await sb
    .from("supplier_contacts")
    .update({ is_default: false, updated_at: new Date().toISOString() })
    .eq("company_id", cid)
    .eq("supplier_key", data.supplier_key as string);
  await sb
    .from("supplier_contacts")
    .update({ is_default: true, updated_at: new Date().toISOString() })
    .eq("company_id", cid)
    .eq("id", id);
}
