# Fixtures — test material for the AB Agent

Run the full pipeline against these files. Iterate until all assertions pass.

## po-exports/
- `open_POs_export.csv` — day 1 baseline: 34 PO lines, 9 suppliers, realistic age spread
  relative to TODAY = Monday 13.07.2026:
  * 1-3 days old, no AB → bucket ⏳ pending (NOT overdue yet)
  * 4-7+ business days old, no AB → must flip to ❌ overdue with chaser drafts
    (4500112990, -991, -992, -902, -888, -870 and the original -956)
  * status 'confirmed' with Confirmed_Delivery filled → must NOT appear in active queue
  * 50-100 days old with far-out delivery dates (long-lead castings) → one still
    unconfirmed (4500112650, 100 days!) = the worst overdue in the set
  The original 5 test PO lines are included UNCHANGED (all acceptance tests still valid).
- `open_POs_export_day2.csv` — day 2: PO 4500112873 now confirmed (must DROP off active queue),
  new PO 4500112970 dated 07.07. (already >3 business days old → immediately overdue-eligible).
  Re-importing must NOT resurrect decided/accepted items (state survival test).
- `sap_real_format.csv` — realistic ugly SAP export: 2 junk header rows, German column names,
  decimal COMMAS (45,80), thousands dots (2.400), Latin-1 encoding. Parser must handle this.

## abs/ (order confirmation PDFs)
- `AB_MetallTech_4500112873.pdf` — clean corporate layout, perfect match → bucket ✅
- `AB_GusswerkHartmann_4500112901.pdf` — 3 deviations, see expected/hartmann_findings.json → bucket ⚠️
- `AB_FedernVogel_4500112944.pdf` — typewriter layout, PO number buried in prose → still ✅

## emails/
- `email_body_only_confirmation.txt` — AB as plain email text, NO attachment, delivery given as
  "KW 32". Must match PO 4500112956 and resolve its overdue chaser. See expected/email_body_expected.json
- `email_forwarded_with_pdf.json` — Postmark-style inbound webhook payload with base64 PDF attachment.
  POST this to /api/inbound → must produce the same result as uploading the PDF directly.
  Posting it TWICE must not create a duplicate (dedupe test).

## garbage/
- `random_invoice.pdf` — an invoice, not an order confirmation. Must land in a friendly
  "not an AB" state. No crash, no bogus match.

## expected/
- Ground-truth JSONs for automated assertions.
