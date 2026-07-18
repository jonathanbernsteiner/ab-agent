-- 0007: Supplier contacts — who to email at each supplier.
--
-- Contacts are learned automatically (the sender of an inbound confirmation
-- email, or the address a user sends a chaser/pushback to) and can be managed
-- in Settings → Contacts. `supplier_key` is a normalized form of the supplier
-- name (lowercase, legal suffixes stripped) so "FEDERN VOGEL KG" from an AB and
-- "Federn Vogel" from the SAP list resolve to the same contact list.
--
-- Apply with: supabase db push, or paste into the Supabase SQL editor.

create table if not exists supplier_contacts (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies(id) on delete cascade,
  supplier     text not null,          -- display name as first seen
  supplier_key text not null,          -- normalized lookup key
  name         text,                   -- contact person, optional
  email        text not null,
  is_default   boolean not null default false,
  source       text not null default 'manual', -- 'inbound' | 'outbound' | 'manual'
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (company_id, supplier_key, email)
);

create index if not exists supplier_contacts_lookup_idx
  on supplier_contacts (company_id, supplier_key);

-- RLS on: only the server (service-role key, which bypasses RLS) touches this.
alter table supplier_contacts enable row level security;
