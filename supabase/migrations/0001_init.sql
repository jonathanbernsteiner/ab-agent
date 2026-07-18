-- AB Agent — initial schema.
--
-- Design rules encoded here:
--   * Nothing is ever deleted from business tables. Closure is a status change
--     (pos.status = 'archived'), decisions/chasers persist keyed to the PO.
--   * The morning SAP import updates FACTS (pos), never DECISIONS (decisions,
--     chasers) — those are separate tables keyed to (po_number, position).
--
-- Apply with: supabase db push, or paste into the Supabase SQL editor.

create extension if not exists "pgcrypto";

-- ── SAP import runs ─────────────────────────────────────────────────────────
create table if not exists import_runs (
  id          uuid primary key default gen_random_uuid(),
  filename    text,
  row_count   int not null default 0,
  mapping     jsonb,                       -- column mapping used for this import
  notes       text,
  created_at  timestamptz not null default now()
);

-- ── Purchase-order lines (the matching baseline) ────────────────────────────
create table if not exists pos (
  id                       uuid primary key default gen_random_uuid(),
  po_number                text not null,
  position                 int  not null,
  article                  text,
  article_desc             text,
  ordered_qty              numeric,
  unit_price               numeric,
  currency                 text default 'EUR',
  requested_date           date,           -- requested delivery date
  po_date                  date,           -- PO placement date (overdue clock start)
  supplier                 text,
  -- confirmation state
  confirmed_date           date,           -- date the tool queued / SAP filled
  confirmed_source         text,           -- 'auto' | 'approved' | 'sap' | null
  external_confirmed_date  date,           -- SAP shows a date the tool didn't write
  -- lifecycle
  status                   text not null default 'open',  -- open|confirmed|archived|externally_changed
  archived_at              timestamptz,
  last_import_run_id       uuid references import_runs(id),
  last_seen_at             timestamptz not null default now(),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (po_number, position)
);
create index if not exists pos_status_idx on pos (status);
create index if not exists pos_po_number_idx on pos (po_number);

-- ── Received order-confirmation documents (ABs) ─────────────────────────────
create table if not exists abs (
  id                 uuid primary key default gen_random_uuid(),
  ab_number          text,
  supplier           text,
  po_number          text,                 -- extracted; may be null on non-ABs
  source             text not null,        -- 'upload' | 'email'
  source_meta        jsonb,                -- email from/subject, uploader, etc.
  storage_path       text,                 -- Supabase Storage path to the original
  original_filename  text,
  mime_type          text,
  content_hash       text not null,        -- dedupe key
  doc_kind           text not null default 'unknown', -- 'ab' | 'not_ab' | 'unknown'
  received_at        timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  unique (content_hash)
);
create index if not exists abs_po_number_idx on abs (po_number);

-- ── Raw extraction output + "what the AI read" ──────────────────────────────
create table if not exists extractions (
  id             uuid primary key default gen_random_uuid(),
  ab_id          uuid not null references abs(id),
  model          text not null,
  raw_output     jsonb not null,           -- full structured tool output
  read_text      text,                     -- the source text the model worked from
  created_at     timestamptz not null default now()
);
create index if not exists extractions_ab_idx on extractions (ab_id);

-- ── Match result per AB (per-position findings live in jsonb) ───────────────
create table if not exists matches (
  id              uuid primary key default gen_random_uuid(),
  ab_id           uuid not null references abs(id),
  extraction_id   uuid references extractions(id),
  po_number       text,
  overall_bucket  text not null,           -- 'match' | 'deviation' | 'no_po'
  positions       jsonb not null default '[]'::jsonb,
  -- positions[]: { position, po_id, article, ordered_qty, extracted_qty,
  --   unit_price, extracted_price, requested_date, confirmed_date, partials[],
  --   bucket, findings[]:{type,severity,human,detail} }
  created_at      timestamptz not null default now(),
  unique (ab_id)
);
create index if not exists matches_po_number_idx on matches (po_number);
create index if not exists matches_bucket_idx on matches (overall_bucket);

-- ── Human decisions — keyed to the PO, survive re-imports ───────────────────
create table if not exists decisions (
  id              uuid primary key default gen_random_uuid(),
  po_number       text not null,
  position        int,
  ab_id           uuid references abs(id),
  kind            text not null,           -- 'accept' | 'escalate' | 'pushback'
  confirmed_date  date,
  confirmed_qty   numeric,
  confirmed_price numeric,
  payload         jsonb,
  decided_by      text default 'Günther',
  created_at      timestamptz not null default now()
);
create index if not exists decisions_po_idx on decisions (po_number, position);

-- ── Chaser state — keyed to the PO, survives re-imports ─────────────────────
create table if not exists chasers (
  id            uuid primary key default gen_random_uuid(),
  po_number     text not null,
  position      int,
  level         int not null default 1,    -- 1 = friendly, 2 = firm with deadline
  status        text not null default 'open',  -- 'open' | 'snoozed' | 'resolved'
  snooze_until  date,
  last_level_at timestamptz not null default now(),
  history       jsonb not null default '[]'::jsonb,  -- append-only log of actions
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (po_number, position)
);
create index if not exists chasers_status_idx on chasers (status);

-- ── Adjustable SAP column mapping (one place) ───────────────────────────────
create table if not exists column_mappings (
  id           uuid primary key default gen_random_uuid(),
  name         text not null default 'default',
  delimiter    text not null default ';',
  decimal_sep  text not null default ',',
  date_format  text not null default 'dd.mm.yyyy',
  encoding     text not null default 'latin1',
  mapping      jsonb not null,             -- logical field -> CSV column header
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- RLS on: only the server (service-role key, which bypasses RLS) touches these.
-- No anon/public policies → the anon key can read nothing.
alter table import_runs     enable row level security;
alter table pos             enable row level security;
alter table abs             enable row level security;
alter table extractions     enable row level security;
alter table matches         enable row level security;
alter table decisions       enable row level security;
alter table chasers         enable row level security;
alter table column_mappings enable row level security;
