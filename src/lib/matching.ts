import { dayDelta, formatDe } from "@/lib/dates";
import {
  PRICE_TOLERANCE,
  type Extraction,
  type ExtractedPosition,
  type Finding,
  type MatchResult,
  type PoLine,
  type PositionResult,
} from "@/lib/types";

// Deterministic matching. Per the spec:
//   quantity = exact (partials: sum must equal ordered, but any split is still
//              a deviation to review)
//   price    = 0.5% tolerance for rounding, beyond -> deviation with % delta
//   date     = confirmed <= requested -> match; later -> deviation w/ day delta
// Matching is PER POSITION — one AB can be half fine, half deviating.

function pct(delta: number, base: number): number {
  if (!base) return 0;
  return (delta / base) * 100;
}

function fmtPct(n: number): string {
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}${Math.abs(n).toFixed(1).replace(".", ",")}%`;
}

function totalQty(ep: ExtractedPosition): number | null {
  if (ep.partial_deliveries.length > 0) {
    return ep.partial_deliveries.reduce((s, p) => s + (p.quantity || 0), 0);
  }
  return ep.quantity;
}

function primaryDate(ep: ExtractedPosition): string | null {
  if (ep.confirmed_delivery_date) return ep.confirmed_delivery_date;
  // fall back to the latest partial date
  const dates = ep.partial_deliveries
    .map((p) => p.delivery_date)
    .filter((d): d is string => !!d)
    .sort();
  return dates.length ? dates[dates.length - 1] : null;
}

// Resolve which PO line an extracted position belongs to.
function resolvePoLine(
  ep: ExtractedPosition,
  poLines: PoLine[],
  used: Set<string>,
  index: number,
): PoLine | null {
  // 1) exact position number
  if (ep.position != null) {
    const byPos = poLines.find(
      (p) => p.position === ep.position && !used.has(p.id!),
    );
    if (byPos) return byPos;
  }
  // 2) article match
  if (ep.article) {
    const target = ep.article.replace(/\s+/g, "").toLowerCase();
    const byArt = poLines.find(
      (p) =>
        p.article &&
        p.article.replace(/\s+/g, "").toLowerCase() === target &&
        !used.has(p.id!),
    );
    if (byArt) return byArt;
  }
  // 3) positional fallback — only the SAME ordinal among the still-free lines.
  // (Never a blind `free[0]` catch-all: an extracted position that matches no
  // PO position number and no article must not be force-bound to an unrelated
  // line, which would manufacture spurious qty/price/date deviations against it
  // and hide the genuinely-unconfirmed line.)
  const free = poLines.filter((p) => !used.has(p.id!));
  return free[index] ?? null;
}

export function matchAb(
  extraction: Extraction,
  poLines: PoLine[],
  // PO position numbers that already carried a confirmation before this AB. A
  // fresh confirmation for such a line is flagged `superseded` so it re-enters
  // review instead of silently overwriting the prior one.
  alreadyConfirmed: Set<number> = new Set(),
): MatchResult {
  // No PO number, no matching PO lines, or not an order confirmation.
  if (
    !extraction.is_order_confirmation ||
    !extraction.po_number ||
    poLines.length === 0
  ) {
    return {
      overall_bucket: "no_po",
      po_number: extraction.po_number,
      positions: [],
    };
  }

  const used = new Set<string>();
  const positions: PositionResult[] = [];

  extraction.positions.forEach((ep, i) => {
    const po = resolvePoLine(ep, poLines, used, i);
    if (po?.id) used.add(po.id);

    const findings: Finding[] = [];
    const confirmedDate = primaryDate(ep);
    const requested = po?.requested_date ?? null;
    const orderedQty = po?.ordered_qty ?? null;
    const poPrice = po?.unit_price ?? null;
    const extractedTotalQty = totalQty(ep);

    if (!po) {
      findings.push({
        type: "extra_position",
        severity: "warn",
        human: `Position ${ep.position ?? i + 1} ohne passende Bestellzeile`,
      });
    } else if (po.position != null && alreadyConfirmed.has(po.position)) {
      findings.push({
        type: "superseded",
        severity: "warn",
        human: `Ersetzt eine frühere Bestätigung für Position ${po.position}`,
        detail: { position: po.position },
      });
    }

    // Date
    if (confirmedDate && requested) {
      const delta = dayDelta(requested, confirmedDate);
      if (delta > 0) {
        findings.push({
          type: "date_later",
          severity: "warn",
          human: `Termin +${delta} Tage: ${formatDe(requested)} → ${formatDe(confirmedDate)}`,
          detail: { requested, confirmed: confirmedDate, days: delta },
        });
      }
    } else if (!confirmedDate) {
      // The supplier could not confirm a date (usually stated in prose).
      const cannot =
        (ep.notes && /nicht|kann|leider|offen|unbe/i.test(ep.notes)) ||
        extraction.global_notes.some((n) => /nicht best|kann.*nicht|offen/i.test(n));
      findings.push({
        type: "unconfirmed_date",
        severity: "warn",
        human: cannot
          ? "Kein Termin bestätigt (laut Text nicht möglich)"
          : "Kein Liefertermin im Dokument gefunden",
      });
    }

    // Partial deliveries — any split is a deviation to review.
    if (ep.partial_deliveries.length > 0) {
      const parts = ep.partial_deliveries
        .map((p) => {
          const q = p.quantity;
          const d = p.delivery_date ? ` (${formatDe(p.delivery_date)})` : "";
          return `${q}${d}`;
        })
        .join(" + ");
      findings.push({
        type: "partial_split",
        severity: "warn",
        human: `Teillieferung: ${parts}`,
        detail: { partials: ep.partial_deliveries },
      });
    }

    // Quantity — exact; partial sums must equal ordered.
    if (orderedQty != null && extractedTotalQty != null) {
      if (Math.abs(extractedTotalQty - orderedQty) > 1e-9) {
        findings.push({
          type: "qty_mismatch",
          severity: "warn",
          human: `Menge ${extractedTotalQty} statt ${orderedQty}`,
          detail: { ordered: orderedQty, confirmed: extractedTotalQty },
        });
      }
    }

    // Currency — a different confirmed currency is a deviation on its own: a
    // price of "100 USD" is not "100 EUR" even though the numbers are equal, so
    // this must be caught before/independent of the numeric-delta check.
    const poCurrency = po?.currency ?? null;
    if (
      poCurrency &&
      ep.currency &&
      poCurrency.toUpperCase() !== ep.currency.toUpperCase()
    ) {
      findings.push({
        type: "currency_mismatch",
        severity: "warn",
        human: `Währung ${ep.currency.toUpperCase()} statt ${poCurrency.toUpperCase()}`,
        detail: {
          po_currency: poCurrency.toUpperCase(),
          ab_currency: ep.currency.toUpperCase(),
        },
      });
    }

    // Price — 0.5% tolerance, then a % delta.
    if (poPrice != null && ep.unit_price != null && poPrice !== 0) {
      const delta = ep.unit_price - poPrice;
      const rel = Math.abs(delta) / Math.abs(poPrice);
      if (rel > PRICE_TOLERANCE) {
        const p = pct(delta, poPrice);
        findings.push({
          type: delta > 0 ? "price_increase" : "price_decrease",
          severity: "warn",
          human: `Preis ${fmtPct(p)}: ${formatDe0(poPrice)} → ${formatDe0(ep.unit_price)} ${po?.currency ?? "EUR"}`,
          detail: { po_price: poPrice, ab_price: ep.unit_price, pct: p },
        });
      }
    }

    positions.push({
      position: ep.position ?? po?.position ?? i + 1,
      po_id: po?.id ?? null,
      article: ep.article ?? po?.article ?? null,
      ordered_qty: orderedQty,
      extracted_qty: extractedTotalQty,
      unit_price: poPrice,
      extracted_price: ep.unit_price,
      requested_date: requested,
      confirmed_date: confirmedDate,
      partials: ep.partial_deliveries,
      bucket: findings.length > 0 ? "deviation" : "match",
      findings,
    });
  });

  // Active PO lines that NO extracted position resolved to were not confirmed by
  // this AB. Surface them as deviations instead of dropping them silently — a
  // supplier confirming 1 of 3 ordered lines must not read as a clean match.
  // (For multi-AB POs, a later AB confirms the rest and clears these.)
  for (const po of poLines) {
    if (po.id && used.has(po.id)) continue;
    positions.push({
      position: po.position ?? null,
      po_id: po.id ?? null,
      article: po.article ?? null,
      ordered_qty: po.ordered_qty ?? null,
      extracted_qty: null,
      unit_price: po.unit_price ?? null,
      extracted_price: null,
      requested_date: po.requested_date ?? null,
      confirmed_date: null,
      partials: [],
      bucket: "deviation",
      findings: [
        {
          type: "unconfirmed_line",
          severity: "warn",
          human: `Position ${po.position ?? "?"} nicht bestätigt`,
          detail: { position: po.position, article: po.article },
        },
      ],
    });
  }

  const overall = positions.some((p) => p.bucket === "deviation")
    ? "deviation"
    : "match";

  return {
    overall_bucket: overall,
    po_number: extraction.po_number,
    positions,
  };
}

// Money without a date — "45,80"
function formatDe0(n: number): string {
  return n.toFixed(2).replace(".", ",");
}
