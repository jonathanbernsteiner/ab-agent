-- 0006: Merge Inbox + Purchase Orders into one line-grain "Matching" spine.
--
-- The `pos` table becomes the spine (grain: company_id, po_number, position).
-- Confirmation facts + a findings summary are promoted onto each line; the AB
-- documents (abs), extractions, matches, decisions and chasers stay as
-- satellites. One projection function in the app (recomputeLineState) is the
-- sole writer of `status` + the promoted columns, so the line never drifts.
--
-- Status vocabulary (was: open | confirmed | archived | externally_changed):
--   awaiting | to_review | confirmed | externally_changed | archived
-- 'overdue' (time-based) and 'exported' (exported_at flag) are DERIVED at read
-- time, never stored. needs_human is derived from the effective status.
--
-- Apply with: supabase db push, or paste into the Supabase SQL editor.

-- ── Promoted confirmation facts on the spine ────────────────────────────────
alter table pos add column if not exists confirmed_qty    numeric;
alter table pos add column if not exists confirmed_price   numeric;
alter table pos add column if not exists findings          jsonb not null default '[]'::jsonb;
alter table pos add column if not exists findings_summary  text;
alter table pos add column if not exists source_ab_id      uuid references abs(id);
alter table pos add column if not exists exported_at        timestamptz;

create index if not exists pos_source_ab_idx on pos (source_ab_id);

-- ── Rename the legacy 'open' lifecycle value to 'awaiting' ───────────────────
update pos set status = 'awaiting' where status = 'open';
alter table pos alter column status set default 'awaiting';

-- ── Unmatched-AB queue ──────────────────────────────────────────────────────
-- An order confirmation whose PO wasn't in SAP yet is kept as a document with
-- matched_at IS NULL. runImport re-matches every such AB whose PO later arrives
-- and stamps matched_at — no human step.
alter table abs add column if not exists matched_at timestamptz;
create index if not exists abs_unmatched_idx
  on abs (company_id, po_number)
  where doc_kind = 'ab' and matched_at is null;
