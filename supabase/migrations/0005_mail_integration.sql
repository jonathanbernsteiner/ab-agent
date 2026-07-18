-- Mailbox auto-triage: connect a real mailbox once, then a scheduled loop reads
-- EVERY new message, a cheap pre-filter decides "is this an order confirmation?",
-- and only survivors enter the (expensive) extraction pipeline. Everything here is
-- inert until a mailbox is connected — the OAuth wiring is the one piece left.
--
-- Two tables:
--   mail_accounts  — one connected mailbox per company (provider, cursor, tokens)
--   mail_events    — an audit row for EVERY message the loop saw and what it did
--                    (ingested / skipped-by-prefilter / skipped-by-classifier /
--                    error). This is the "why did/didn't you process this mail?"
--                    log — trust depends on it, since a missed AB in a mailbox we
--                    promised to watch is on us.

-- ── Connected mailboxes ─────────────────────────────────────────────────────
create table if not exists mail_accounts (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references companies(id) on delete cascade,
  provider       text not null,                    -- 'gmail' | 'microsoft' | 'manual'
  external_email text,                             -- the connected address, once known
  status         text not null default 'disconnected', -- 'disconnected'|'connected'|'error'
  -- OAuth material. Nullable now (nothing connected yet); a token vault fills
  -- these when a provider is wired up. Never sent to the browser.
  access_token   text,
  refresh_token  text,
  token_expires_at timestamptz,
  -- Provider sync cursor (Gmail historyId / Graph deltaLink / IMAP UID) so each
  -- poll only pulls messages newer than the last processed one.
  cursor         text,
  last_polled_at timestamptz,
  last_error     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists mail_accounts_company_idx on mail_accounts(company_id);
-- One account per (company, provider, address). Re-connecting updates in place.
create unique index if not exists mail_accounts_company_provider_email_key
  on mail_accounts(company_id, provider, coalesce(external_email, ''));

-- ── Per-message audit log ───────────────────────────────────────────────────
create table if not exists mail_events (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references companies(id) on delete cascade,
  account_id          uuid references mail_accounts(id) on delete set null,
  provider            text not null,               -- 'gmail'|'microsoft'|'manual'
  external_message_id text not null,               -- provider's stable message id
  from_addr           text,
  subject             text,
  -- 'ingested' | 'skipped_prefilter' | 'skipped_classifier' | 'error'
  decision            text not null,
  reason              text,                         -- human-readable why
  classifier_confidence text,                       -- 'high'|'medium'|'low'|null
  ab_id               uuid references abs(id) on delete set null, -- set when ingested
  created_at          timestamptz not null default now()
);
create index if not exists mail_events_company_idx on mail_events(company_id, created_at desc);
-- Idempotency: the loop processes a provider message at most once, even across
-- overlapping polls. This is upstream of the pipeline's content-hash dedupe.
create unique index if not exists mail_events_company_msg_key
  on mail_events(company_id, provider, external_message_id);

-- ── RLS (defense-in-depth; server uses the service role and scopes by company) ─
alter table mail_accounts enable row level security;
alter table mail_events   enable row level security;

drop policy if exists company_isolation on mail_accounts;
create policy company_isolation on mail_accounts
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

drop policy if exists company_isolation on mail_events;
create policy company_isolation on mail_events
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());
