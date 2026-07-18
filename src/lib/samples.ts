import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

// The pre-seeded demo data set. These are the exact documents the acceptance
// tests run against. They are GENERATED here (no fixtures), stored, and put
// through the real extraction pipeline at seed time.

// ── Reference dates (2026 demo timeframe) ───────────────────────────────────
const METALLTECH_DATE = "24.07.2026";
const HARTMANN_REQUESTED = "29.07.2026";
const HARTMANN_P1 = "05.08.2026"; // 500 pcs
const HARTMANN_P2 = "19.08.2026"; // 300 pcs
const VOGEL_DATE = "14.08.2026";

// The overdue PO's placement date is dynamic: ~5 business days before "today",
// so it reliably reads as overdue at level 1 whenever the demo is seeded.
function subtractBusinessDays(from: Date, n: number): Date {
  const d = new Date(from);
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() - 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) left--;
  }
  return d;
}
function de(d: Date): string {
  return `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.${d.getUTCFullYear()}`;
}

export interface SampleDoc {
  key: string;
  filename: string;
  title: string;
  supplier: string;
  poNumber: string | null;
  isAb: boolean;
  bytes: Uint8Array;
}

// ── SAP PO export (semicolon, decimal comma, Latin-1, junk header rows) ──────
export function buildPoCsv(): string {
  const overduePoDate = de(subtractBusinessDays(new Date(), 5));
  const rows = [
    // Junk / metadata header rows a real SAP export prepends.
    "SAP Bestellübersicht - Export",
    `Erstellt am;${de(new Date())};Mandant 100`,
    "",
    // Real header row.
    "Bestellnr;Pos;Material;Kurztext;Menge;Preis;Waehrung;Wunschtermin;Belegdatum;Lieferant;Bestaetigt",
    // MetallTech — two clean positions (will match).
    `4500112873;10;ST-100;Stahlblech 100x200;100;12,50;EUR;${METALLTECH_DATE};08.07.2026;MetallTech GmbH;`,
    `4500112873;20;ST-200;Stahlrohr 20mm;50;8,00;EUR;${METALLTECH_DATE};08.07.2026;MetallTech GmbH;`,
    // Gusswerk Hartmann — one position (will deviate on date, split, price).
    `4500112901;10;GH-800;Gussteil Flansch DN80;800;45,80;EUR;${HARTMANN_REQUESTED};07.07.2026;Gusswerk Hartmann GmbH;`,
    // Federn Vogel — one position (typewriter AB, buried PO number; will match).
    `4500112944;10;FV-50;Druckfeder 50mm;200;3,20;EUR;${VOGEL_DATE};02.07.2026;Federn Vogel KG;`,
    // No AB in the set — will show as awaiting, then overdue with a level-1 chaser.
    `4500112956;10;DK-12;Dichtung 12mm;300;1,10;EUR;28.07.2026;${overduePoDate};Dichtungswerk Süd GmbH;`,
    // Footer junk.
    "Summe;5 Positionen;;;;;;;;;",
  ];
  return rows.join("\r\n") + "\r\n";
}

// Latin-1 encoded bytes (umlauts) to exercise the encoding-fallback path.
export function buildPoCsvBytes(): Uint8Array {
  const text = buildPoCsv();
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    out[i] = c <= 0xff ? c : 0x3f; // '?'
  }
  return out;
}

// ── PDF layout helpers ──────────────────────────────────────────────────────
interface Ctx {
  page: PDFPage;
  font: PDFFont;
  bold: PDFFont;
  mono: PDFFont;
  y: number;
}

function line(ctx: Ctx, text: string, opts: { size?: number; bold?: boolean; mono?: boolean; gap?: number } = {}) {
  const size = opts.size ?? 11;
  const f = opts.mono ? ctx.mono : opts.bold ? ctx.bold : ctx.font;
  ctx.page.drawText(text, { x: 56, y: ctx.y, size, font: f, color: rgb(0.06, 0.09, 0.16) });
  ctx.y -= (opts.gap ?? size + 6);
}

function wrapped(ctx: Ctx, text: string, opts: { size?: number; mono?: boolean; width?: number } = {}) {
  const size = opts.size ?? 11;
  const f = opts.mono ? ctx.mono : ctx.font;
  const maxWidth = opts.width ?? 480;
  const words = text.split(" ");
  let cur = "";
  for (const w of words) {
    const test = cur ? cur + " " + w : w;
    if (f.widthOfTextAtSize(test, size) > maxWidth && cur) {
      line(ctx, cur, { size, mono: opts.mono });
      cur = w;
    } else {
      cur = test;
    }
  }
  if (cur) line(ctx, cur, { size, mono: opts.mono });
}

// A fixed epoch for all generated sample metadata. pdf-lib otherwise stamps the
// PDF info dict with `new Date()` on every build, so the bytes — and therefore
// the content hash — would differ each run and a re-seed would never dedupe
// (and would needlessly re-extract). Pinning these makes sample bytes stable,
// so the demo's dedupe story holds and a non-reset re-seed is idempotent.
const SAMPLE_EPOCH = new Date("2026-07-01T00:00:00.000Z");

async function newDoc() {
  const doc = await PDFDocument.create();
  doc.setCreationDate(SAMPLE_EPOCH);
  doc.setModificationDate(SAMPLE_EPOCH);
  doc.setProducer("ab-agent-samples");
  doc.setCreator("ab-agent-samples");
  const page = doc.addPage([595, 842]); // A4
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.Courier);
  const ctx: Ctx = { page, font, bold, mono, y: 786 };
  return { doc, ctx };
}

// ── The three ABs + one non-AB flyer ────────────────────────────────────────

async function metallTechPdf(): Promise<Uint8Array> {
  const { doc, ctx } = await newDoc();
  line(ctx, "MetallTech GmbH", { size: 18, bold: true });
  line(ctx, "Industriestraße 4 · 40210 Düsseldorf", { size: 9 });
  ctx.y -= 10;
  line(ctx, "AUFTRAGSBESTÄTIGUNG", { size: 14, bold: true });
  line(ctx, "AB-Nr.: AB-2026-4471", { size: 10 });
  line(ctx, "Datum: 09.07.2026", { size: 10 });
  ctx.y -= 6;
  wrapped(ctx, "Sehr geehrte Damen und Herren, wir bestätigen Ihre Bestellung 4500112873 wie folgt:");
  ctx.y -= 8;
  line(ctx, "Pos  Material   Bezeichnung          Menge   Preis/Stk   Liefertermin", { size: 10, mono: true });
  line(ctx, "10   ST-100     Stahlblech 100x200   100     12,50 EUR   " + METALLTECH_DATE, { size: 10, mono: true });
  line(ctx, "20   ST-200     Stahlrohr 20mm        50     8,00 EUR    " + METALLTECH_DATE, { size: 10, mono: true });
  ctx.y -= 10;
  wrapped(ctx, "Alle Positionen werden zum Wunschtermin geliefert. Preise und Mengen entsprechen Ihrer Bestellung.");
  ctx.y -= 8;
  line(ctx, "Mit freundlichen Grüßen");
  line(ctx, "MetallTech GmbH · Vertrieb");
  return doc.save();
}

async function hartmannPdf(): Promise<Uint8Array> {
  const { doc, ctx } = await newDoc();
  line(ctx, "Gusswerk Hartmann GmbH", { size: 18, bold: true });
  line(ctx, "Am Hochofen 12 · 58089 Hagen", { size: 9 });
  ctx.y -= 10;
  line(ctx, "Auftragsbestätigung Nr. AB-GH-88213", { size: 13, bold: true });
  line(ctx, "vom 10.07.2026 zu Ihrer Bestellung 4500112901", { size: 10 });
  ctx.y -= 6;
  wrapped(ctx, "Sehr geehrte Damen und Herren, vielen Dank für Ihren Auftrag. Wir bestätigen wie folgt:");
  ctx.y -= 8;
  line(ctx, "Pos  Material   Bezeichnung            Menge   Liefertermin", { size: 10, mono: true });
  line(ctx, "10   GH-800     Gussteil Flansch DN80  500     " + HARTMANN_P1, { size: 10, mono: true });
  line(ctx, "                 Restmenge             300     " + HARTMANN_P2, { size: 10, mono: true });
  ctx.y -= 10;
  // Price change hidden in PROSE — deliberately NOT in the table above.
  wrapped(
    ctx,
    "Bitte beachten Sie: Aufgrund erheblich gestiegener Rohstoff- und Energiekosten müssen wir den Stückpreis für die Position GH-800 von bisher 45,80 EUR auf nunmehr 47,20 EUR anpassen. Wir bitten um Ihr Verständnis.",
  );
  ctx.y -= 6;
  wrapped(
    ctx,
    "Der von Ihnen gewünschte Liefertermin " + HARTMANN_REQUESTED + " kann leider nicht vollständig gehalten werden; die Lieferung erfolgt in zwei Teillieferungen wie oben angegeben.",
  );
  ctx.y -= 8;
  line(ctx, "Mit freundlichen Grüßen · Gusswerk Hartmann GmbH");
  return doc.save();
}

async function vogelPdf(): Promise<Uint8Array> {
  // Typewriter look: everything in Courier, cramped, PO number buried in prose.
  const { doc, ctx } = await newDoc();
  line(ctx, "FEDERN VOGEL KG", { size: 12, mono: true });
  line(ctx, "Postfach 118 - 73728 Esslingen", { size: 10, mono: true });
  line(ctx, "Fernruf 0711/44556 - Telex 7255", { size: 10, mono: true });
  ctx.y -= 14;
  line(ctx, "A U F T R A G S B E S T A E T I G U N G", { size: 11, mono: true });
  ctx.y -= 10;
  wrapped(
    ctx,
    "Sehr geehrte Herren, bezugnehmend auf Ihre Bestellung Nr. 4500112944 vom 02.07.2026 bestaetigen wir Ihnen hiermit die nachstehend aufgefuehrte Lieferung zu den vereinbarten Konditionen.",
    { mono: true, width: 460 },
  );
  ctx.y -= 10;
  line(ctx, "Menge   Artikel   Bezeichnung        Preis     Termin", { size: 10, mono: true });
  line(ctx, "200 St  FV-50     Druckfeder 50mm    3,20 EUR  " + VOGEL_DATE, { size: 10, mono: true });
  ctx.y -= 12;
  wrapped(ctx, "Die Lieferung erfolgt frei Haus zum genannten Termin. Menge und Preis gemaess Ihrer Bestellung.", { mono: true, width: 460 });
  ctx.y -= 10;
  line(ctx, "Hochachtungsvoll", { size: 10, mono: true });
  line(ctx, "FEDERN VOGEL KG", { size: 10, mono: true });
  return doc.save();
}

async function flyerPdf(): Promise<Uint8Array> {
  // A random non-AB document to demonstrate graceful failure.
  const { doc, ctx } = await newDoc();
  line(ctx, "Sommer-Aktion 2026!", { size: 22, bold: true });
  ctx.y -= 8;
  wrapped(ctx, "Sichern Sie sich jetzt 20% Rabatt auf unser gesamtes Werkzeug-Sortiment. Nur solange der Vorrat reicht!");
  ctx.y -= 8;
  wrapped(ctx, "Besuchen Sie unseren Showroom oder bestellen Sie online. Dieses Schreiben ist keine Auftragsbestätigung.");
  return doc.save();
}

export async function buildSampleDocs(): Promise<SampleDoc[]> {
  return [
    {
      key: "metalltech",
      filename: "AB_MetallTech_4500112873.pdf",
      title: "MetallTech — AB zu Bestellung 4500112873",
      supplier: "MetallTech GmbH",
      poNumber: "4500112873",
      isAb: true,
      bytes: await metallTechPdf(),
    },
    {
      key: "hartmann",
      filename: "AB_Gusswerk_Hartmann_4500112901.pdf",
      title: "Gusswerk Hartmann — AB zu Bestellung 4500112901",
      supplier: "Gusswerk Hartmann GmbH",
      poNumber: "4500112901",
      isAb: true,
      bytes: await hartmannPdf(),
    },
    {
      key: "vogel",
      filename: "AB_Federn_Vogel_4500112944.pdf",
      title: "Federn Vogel — AB zu Bestellung 4500112944 (Schreibmaschine)",
      supplier: "Federn Vogel KG",
      poNumber: "4500112944",
      isAb: true,
      bytes: await vogelPdf(),
    },
    {
      key: "flyer",
      filename: "Werbeprospekt.pdf",
      title: "Werbeprospekt (keine AB) — zum Testen der Fehlerbehandlung",
      supplier: "—",
      poNumber: null,
      isAb: false,
      bytes: await flyerPdf(),
    },
  ];
}
