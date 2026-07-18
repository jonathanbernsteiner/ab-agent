import { formatDe, addBusinessDays, todayIso } from "@/lib/dates";
import type { Finding, PoLine } from "@/lib/types";

export interface EmailDraft {
  to: string; // recipient email, empty if unknown (user fills in)
  subject: string;
  body: string;
}

export interface Signature {
  name?: string | null;
  company?: string | null;
}

// A signed-off closing. Uses the logged-in user's name + company (from Settings),
// falling back to a neutral "Einkauf" when no name is set.
function signOff(sig?: Signature): string {
  const name = sig?.name?.trim();
  const company = sig?.company?.trim();
  const who = name || "Einkauf";
  return company ? `${who}\n${company}` : who;
}

// ── Overdue chaser (Nachfass) — German, editable before sending ─────────────

// Level 1: friendly reminder. Level 2: firm, with a deadline.
export function buildChaser(
  po: Pick<PoLine, "po_number" | "supplier" | "article" | "requested_date" | "po_date">,
  level: 1 | 2,
  sig?: Signature,
  to = "",
): EmailDraft {
  const anrede = po.supplier ? `Sehr geehrte Damen und Herren bei ${po.supplier},` : "Sehr geehrte Damen und Herren,";
  const bestellung = `unsere Bestellung ${po.po_number}${po.po_date ? ` vom ${formatDe(po.po_date)}` : ""}`;
  const artikel = po.article ? ` (Artikel ${po.article})` : "";

  if (level === 1) {
    return {
      to,
      subject: `Auftragsbestätigung ausstehend – Bestellung ${po.po_number}`,
      body: `${anrede}

zu ${bestellung}${artikel} liegt uns bisher keine Auftragsbestätigung vor.

Bitte senden Sie uns die Auftragsbestätigung mit dem bestätigten Liefertermin${po.requested_date ? ` (gewünscht: ${formatDe(po.requested_date)})` : ""} zu.

Vielen Dank und freundliche Grüße
${signOff(sig)}`,
    };
  }

  const frist = addBusinessDays(todayIso(), 3);
  return {
    to,
    subject: `2. Erinnerung / Frist – Auftragsbestätigung Bestellung ${po.po_number}`,
    body: `${anrede}

trotz unserer Erinnerung haben wir zu ${bestellung}${artikel} weiterhin keine Auftragsbestätigung erhalten.

Wir benötigen die Auftragsbestätigung mit verbindlichem Liefertermin bis spätestens ${formatDe(frist)}. Sollte bis dahin keine Rückmeldung erfolgen, behalten wir uns weitere Schritte vor.

Freundliche Grüße
${signOff(sig)}`,
  };
}

// ── Merged chaser — one email covering several POs of the same supplier ─────

export interface ChaserPo {
  po_number: string;
  article: string | null;
  requested_date: string | null;
  po_date: string | null;
}

// Bulk "one email per supplier": lists every open PO as a bullet. Falls back
// to the singular wording via buildChaser when only one PO is in the group.
// Level 2 when any of the POs has escalated — one firm mail beats mixing tones.
export function buildMergedChaser(
  supplier: string | null,
  pos: ChaserPo[],
  level: 1 | 2,
  sig?: Signature,
  to = "",
): EmailDraft {
  if (pos.length === 1) {
    return buildChaser({ ...pos[0], supplier }, level, sig, to);
  }

  const anrede = supplier ? `Sehr geehrte Damen und Herren bei ${supplier},` : "Sehr geehrte Damen und Herren,";
  const liste = pos
    .map((p) => {
      const datum = p.po_date ? ` vom ${formatDe(p.po_date)}` : "";
      const artikel = p.article ? ` (Artikel ${p.article})` : "";
      const termin = p.requested_date ? ` – gewünschter Liefertermin ${formatDe(p.requested_date)}` : "";
      return `- Bestellung ${p.po_number}${datum}${artikel}${termin}`;
    })
    .join("\n");

  if (level === 1) {
    return {
      to,
      subject: `Auftragsbestätigungen ausstehend – ${pos.length} Bestellungen`,
      body: `${anrede}

zu den folgenden Bestellungen liegt uns bisher keine Auftragsbestätigung vor:

${liste}

Bitte senden Sie uns die Auftragsbestätigungen mit den bestätigten Lieferterminen zu.

Vielen Dank und freundliche Grüße
${signOff(sig)}`,
    };
  }

  const frist = addBusinessDays(todayIso(), 3);
  return {
    to,
    subject: `2. Erinnerung / Frist – Auftragsbestätigungen zu ${pos.length} Bestellungen`,
    body: `${anrede}

trotz unserer Erinnerung haben wir zu den folgenden Bestellungen weiterhin keine Auftragsbestätigung erhalten:

${liste}

Wir benötigen die Auftragsbestätigungen mit verbindlichen Lieferterminen bis spätestens ${formatDe(frist)}. Sollte bis dahin keine Rückmeldung erfolgen, behalten wir uns weitere Schritte vor.

Freundliche Grüße
${signOff(sig)}`,
  };
}

// ── Internal escalation (level 3) — after two unanswered reminders the mail
// goes to a colleague (PO owner / manager), not the supplier a third time ────

export function buildEscalation(
  po: Pick<PoLine, "po_number" | "supplier" | "article" | "requested_date" | "po_date">,
  businessDaysWaiting: number,
  sig?: Signature,
  to = "",
): EmailDraft {
  const lieferant = po.supplier ?? "Lieferant";
  const bestellung = `Bestellung ${po.po_number}${po.po_date ? ` vom ${formatDe(po.po_date)}` : ""}`;
  const artikel = po.article ? ` (Artikel ${po.article})` : "";

  return {
    to,
    subject: `Eskalation: keine Auftragsbestätigung – ${bestellung} (${lieferant})`,
    body: `Hallo,

zu ${bestellung}${artikel} von ${lieferant} liegt trotz zweifacher Erinnerung (zuletzt mit Fristsetzung) seit ${businessDaysWaiting} Arbeitstagen keine Auftragsbestätigung vor.${po.requested_date ? `\n\nGewünschter Liefertermin: ${formatDe(po.requested_date)}.` : ""}

Bitte übernimm die weitere Klärung mit dem Lieferanten bzw. entscheide über das weitere Vorgehen.

Vielen Dank und freundliche Grüße
${signOff(sig)}`,
  };
}

// ── Pushback on a deviation — references the concrete deltas ─────────────────

export function buildPushback(
  po: Pick<PoLine, "po_number" | "supplier" | "requested_date">,
  findings: Finding[],
  sig?: Signature,
  to = "",
): EmailDraft {
  const anrede = po.supplier ? `Sehr geehrte Damen und Herren bei ${po.supplier},` : "Sehr geehrte Damen und Herren,";
  const punkte = findings.map((f) => `- ${f.human}`).join("\n");

  return {
    to,
    subject: `Rückfrage zur Auftragsbestätigung – Bestellung ${po.po_number}`,
    body: `${anrede}

vielen Dank für Ihre Auftragsbestätigung zu Bestellung ${po.po_number}. Bei der Prüfung sind uns folgende Abweichungen zu unserer Bestellung aufgefallen:

${punkte}

Bitte bestätigen Sie uns${po.requested_date ? ` den ursprünglich gewünschten Liefertermin ${formatDe(po.requested_date)} bzw.` : ""} klären Sie die oben genannten Punkte kurzfristig mit uns.

Freundliche Grüße
${signOff(sig)}`,
  };
}
