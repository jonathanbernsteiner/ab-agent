import { formatEn } from "@/lib/dates";
import type { Finding } from "@/lib/types";

// English UI label for a finding, derived from its structured `detail`.
// (The German `finding.human` is kept for the pushback emails; UI chrome is
// English per the interface spec.)
export function findingLabelEn(f: Finding): string {
  const d = f.detail ?? {};
  switch (f.type) {
    case "date_later":
      return `Date: ${formatEn(d.requested as string)} → ${formatEn(d.confirmed as string)} (+${d.days} days)`;
    case "partial_split": {
      const parts = (d.partials as { quantity: number; delivery_date: string | null }[]) ?? [];
      const rendered = parts
        .map((p) => `${p.quantity}${p.delivery_date ? ` (${formatEn(p.delivery_date)})` : ""}`)
        .join(" + ");
      return `Partial delivery: ${rendered}`;
    }
    case "price_increase":
    case "price_decrease": {
      const pct = d.pct as number;
      const sign = pct > 0 ? "+" : pct < 0 ? "−" : "";
      return `Price ${sign}${Math.abs(pct).toFixed(1)}%: ${fmt(d.po_price)} → ${fmt(d.ab_price)}`;
    }
    case "qty_mismatch":
      return `Qty ${d.confirmed} instead of ${d.ordered}`;
    case "currency_mismatch":
      return `Currency ${d.ab_currency} instead of ${d.po_currency}`;
    case "unconfirmed_date":
      return "No delivery date confirmed";
    case "unconfirmed_line":
      return "Line not confirmed by the supplier";
    case "extra_position":
      return "Position has no matching PO line";
    case "no_po_line":
      return "No matching PO line";
    case "superseded":
      return "Superseded a previous confirmation";
    default:
      return f.human;
  }
}

// A short one-line summary for a table cell, e.g. "Date +7 days · Price +3.1%".
export function findingsSummaryEn(findings: Finding[]): string {
  const parts: string[] = [];
  for (const f of findings) {
    const d = f.detail ?? {};
    switch (f.type) {
      case "date_later":
        parts.push(`Date +${d.days} days`);
        break;
      case "partial_split":
        parts.push("Partial delivery");
        break;
      case "price_increase":
      case "price_decrease": {
        const pct = d.pct as number;
        parts.push(`Price ${pct > 0 ? "+" : "−"}${Math.abs(pct).toFixed(1)}%`);
        break;
      }
      case "qty_mismatch":
        parts.push("Qty mismatch");
        break;
      case "currency_mismatch":
        parts.push("Currency mismatch");
        break;
      case "unconfirmed_date":
        parts.push("No date confirmed");
        break;
      case "unconfirmed_line":
        parts.push("Line not confirmed");
        break;
      case "extra_position":
        parts.push("Extra position");
        break;
      case "no_po_line":
        parts.push("Line not confirmed");
        break;
      case "superseded":
        parts.push("Superseded");
        break;
      default:
        parts.push(f.type);
    }
  }
  return parts.join(" · ");
}

function fmt(n: unknown): string {
  return typeof n === "number" ? n.toFixed(2) : "–";
}
