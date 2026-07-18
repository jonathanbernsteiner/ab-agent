-- Multi-tenancy: companies + user profiles, and a company_id on every business
-- table so one Supabase project serves many companies with isolated data.
--
-- The server uses the service-role key (which bypasses RLS) and scopes every
-- query by company_id in code; the RLS policies below are defense-in-depth for
-- any future direct anon/authenticated access.

-- ── Companies (the tenant) ──────────────────────────────────────────────────
create table if not exists companies (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  intake_email  text unique,               -- inbound webhook resolves tenant by this
  overdue_days  int  not null default 3,
  level2_days   int  not null default 3,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ── Profiles (1:1 with auth.users) ──────────────────────────────────────────
create table if not exists profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  company_id  uuid references companies(id) on delete cascade,
  name        text,
  email       text,
  role        text not null default 'member',   -- 'owner' | 'member'
  created_at  timestamptz not null default now()
);
create index if not exists profiles_company_idx on profiles(company_id);

-- ── company_id on every business table ──────────────────────────────────────
alter table pos             add column if not exists company_id uuid references companies(id);
alter table abs             add column if not exists company_id uuid references companies(id);
alter table extractions     add column if not exists company_id uuid references companies(id);
alter table matches         add column if not exists company_id uuid references companies(id);
alter table decisions       add column if not exists company_id uuid references companies(id);
alter table chasers         add column if not exists company_id uuid references companies(id);
alter table import_runs     add column if not exists company_id uuid references companies(id);
alter table export_runs     add column if not exists company_id uuid references companies(id);
alter table column_mappings add column if not exists company_id uuid references companies(id);
alter table app_settings    add column if not exists company_id uuid references companies(id);

create index if not exists pos_company_idx       on pos(company_id);
create index if not exists abs_company_idx       on abs(company_id);
create index if not exists matches_company_idx   on matches(company_id);
create index if not exists decisions_company_idx on decisions(company_id);
create index if not exists chasers_company_idx   on chasers(company_id);
create index if not exists import_runs_company_idx on import_runs(company_id);

-- ── Re-key uniqueness by company so two tenants can share a PO number / doc ──
alter table pos     drop constraint if exists pos_po_number_position_key;
create unique index if not exists pos_company_po_pos_key on pos(company_id, po_number, position);

alter table abs     drop constraint if exists abs_content_hash_key;
create unique index if not exists abs_company_hash_key on abs(company_id, content_hash);

alter table chasers drop constraint if exists chasers_po_number_position_key;
create unique index if not exists chasers_company_po_pos_key on chasers(company_id, po_number, position);

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- current_company_id(): the caller's tenant, resolved WITHOUT tripping RLS
-- recursion (security definer). Returns null for the service role (auth.uid()
-- is null there — and the service role bypasses RLS anyway).
create or replace function public.current_company_id()
returns uuid language sql stable security definer set search_path = public as $$
  select company_id from public.profiles where id = auth.uid()
$$;

alter table companies enable row level security;
alter table profiles  enable row level security;

drop policy if exists companies_own on companies;
create policy companies_own on companies
  for select using (id = public.current_company_id());

drop policy if exists profiles_same_company on profiles;
create policy profiles_same_company on profiles
  for select using (company_id = public.current_company_id() or id = auth.uid());

-- Business tables: a caller may only touch its own company's rows.
do $$
declare t text;
begin
  foreach t in array array[
    'pos','abs','extractions','matches','decisions','chasers',
    'import_runs','export_runs','column_mappings','app_settings'
  ] loop
    execute format('drop policy if exists company_isolation on %I', t);
    execute format(
      'create policy company_isolation on %I using (company_id = public.current_company_id()) with check (company_id = public.current_company_id())',
      t
    );
  end loop;
end $$;
