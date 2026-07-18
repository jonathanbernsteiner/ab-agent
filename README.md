# AB Agent

**AI-powered matching of supplier order confirmations against open purchase orders.**

Purchasing teams spend hours reading order confirmations (ABs) and comparing
them line by line against POs — dates, quantities, prices. Most match anyway;
the few deviations hide in PDFs and email prose. AB Agent reads every
confirmation, matches it against the PO, and surfaces only the judgement calls.
Everything else flows through automatically.

No ERP integration required — CSV in, CSV out.

## How it works

1. **Upload** — Import the open PO list as a CSV export from the ERP.
2. **Match & route** — An LLM extracts positions from each incoming
   confirmation (PDF or email text) and matches them against the corresponding
   PO lines, including deviations buried in free text. Every position lands in
   one of three buckets:
   - ✅ **Match** → auto-filed, queued for export. Zero clicks.
   - ⚠️ **Deviation** → a card stating each finding in plain terms, with
     Accept / Push back / Escalate.
   - ⏳ **No confirmation yet** → flagged overdue after 3 business days, with a
     pre-written chaser (level 1, then level 2 with a deadline, then internal
     escalation).
3. **Export** — At the end of the day, one CSV with all confirmed dates goes
   back into the ERP via mass import.

Confirmations arrive by manual upload, a forward-to-intake email webhook, or a
connected **Gmail mailbox** that scans every incoming message (a cheap
classifier filters out non-ABs before the expensive extraction ever runs).
Pushback and chaser drafts send as real emails from the same mailbox, threaded
onto the supplier's original message.

## Stack

- **Next.js 16** (App Router) · **Tailwind v4 + shadcn** on a custom design system
- **Anthropic Claude** for extraction — server-side only, forced tool-use
- **Supabase** — Postgres + Auth (multi-tenant, RLS) + Storage (original PDFs)
- **Tests** — Node's built-in runner (`node --test`) via `tsx`, no extra framework

## Getting started

1. **Install**
   ```bash
   npm install
   ```
2. **Environment**
   ```bash
   cp .env.local.example .env.local
   ```
   Required: `ANTHROPIC_API_KEY`, `NEXT_PUBLIC_SUPABASE_URL`,
   `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (server-only —
   it bypasses RLS and is never sent to the browser). Everything else is
   optional and documented in `.env.local.example`, including the Google OAuth
   credentials for the Gmail integration.
3. **Database** — apply the migrations in `supabase/migrations/` in order
   (Supabase SQL editor or `supabase db push`). The storage bucket is created
   automatically on first use.
4. **Run & seed**
   ```bash
   npm run dev
   npm run seed   # imports a sample PO list and runs REAL extraction
                  # on generated sample ABs — no canned results
   ```

Open <http://localhost:3000> and sign in with the demo account — the seed
creates it and prints the credentials (the password is regenerated on every
seed; set `SEED_DEMO_PASSWORD` to pin it). The seed pre-loads one matched AB,
one deviation with three findings, and one overdue PO with a drafted chaser.

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` / `build` / `start` | Next.js dev / production build / serve |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` (must stay clean) |
| `npm test` | Runs the real pipeline against `fixtures/` (see below) |
| `npm run seed` | Seeds the live demo state via `/api/seed` |

## Automated tests

```bash
npm test          # 28 tests run offline, 6 more gated on ANTHROPIC_API_KEY
npm run typecheck
```

The suite in `tests/` drives the **real** import / matching / store / dedupe /
export / read-model code against `fixtures/` — an in-memory Supabase stand-in
replaces the live DB, so no Docker or network is needed while every line of
business logic remains the production path. Offline coverage includes parsing
ugly real-format SAP CSVs (junk rows, German number formats, Latin-1), state
survival across re-imports (decisions are never resurfaced), the deterministic
matching rules, overdue/escalation queues, export formatting, and adversarial
edge cases.

Six extraction tests run the **real** Claude extraction over the fixture
PDFs/emails and assert against the ground truth in `fixtures/expected/*.json`
(including a price change hidden in prose). They skip with a clear message
unless `ANTHROPIC_API_KEY` is set — nothing is hardcoded. `fixtures/README.md`
documents every file and its expected outcome.

## Architecture notes

- **Pipeline** (`src/lib/pipeline.ts`): dedupe → store original → extract
  (`src/lib/extraction/`) → match (`src/lib/matching.ts`, deterministic and
  pure) → persist → auto-resolve chasers.
- **Imports update facts, never decisions.** Accepted deviations, snoozes, and
  chaser levels survive re-imports; absent PO lines are archived, never
  deleted; if the ERP export shows a confirmed date the tool didn't write, the
  ERP wins and the change is logged. Nothing in the business tables is ever
  deleted.
- **Multi-tenant.** Signing up creates a company; owners invite teammates from
  Settings. All queries are scoped to the caller's company, with Postgres RLS
  as a second line of defense. The inbound webhook resolves the tenant by
  recipient address.
- **Mailbox loop.** Provider push (`/api/mail/push`) processes new mail the
  moment it arrives; a 10-minute poll cron is the reconciliation safety net.
  Every message seen is recorded in an audit log with its decision, visible in
  Settings → Integrations. Gmail is live; Microsoft is a provider stub.

## Deploy (Vercel)

Set the same env vars in the Vercel project, apply the migrations to your
Supabase project, deploy, then seed against the deployed URL:

```bash
SEED_BASE_URL=https://your-app.vercel.app npm run seed
```

For inbound email, either connect a Gmail mailbox in Settings → Integrations,
or point a provider webhook (Resend/Postmark) at
`https://your-app.vercel.app/api/inbound` (guarded by
`INBOUND_WEBHOOK_SECRET`).

## Roadmap

- Real-time Gmail push (Pub/Sub) — the poll cron covers ingestion today
- Direct ERP API integration (read/write) — CSV in / CSV out for now
- Microsoft 365 mailbox provider (Graph delta) — interface is in place
- Email-based teammate invites
- Supplier analytics from the retained history

Known v1 matching limits (deliberate, documented rather than silently
mis-handled): partial ABs don't flag still-unconfirmed PO lines, article
substitutions on a matched position aren't detected, and zero-priced PO lines
skip the price check. Rate limiting is in-memory per instance — back it with a
shared store for real enforcement.
