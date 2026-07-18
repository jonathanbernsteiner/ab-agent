import * as React from "react";
import { cn } from "@/lib/utils";

// Brand white card — 12px radius, 1px #E2E8F0 border. The AB Agent house card.
// (Named Panel to avoid a case-collision with shadcn's card.tsx on
// case-insensitive filesystems.)
export function Panel({
  className,
  style,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("bg-card", className)}
      style={{
        border: "1px solid #E2E8F0",
        borderRadius: 12,
        ...style,
      }}
      {...props}
    />
  );
}

export type Bucket = "match" | "deviation" | "overdue" | "pending" | "no_ab";

const BUCKET_STYLES: Record<
  Bucket,
  { label: string; fg: string; bg: string; dot: string }
> = {
  match: { label: "Match", fg: "var(--ok)", bg: "var(--ok-bg)", dot: "var(--ok)" },
  deviation: {
    label: "Abweichung",
    fg: "var(--warn)",
    bg: "var(--warn-bg)",
    dot: "var(--warn)",
  },
  overdue: {
    label: "Überfällig",
    fg: "var(--overdue)",
    bg: "var(--overdue-bg)",
    dot: "var(--overdue)",
  },
  no_ab: {
    label: "Keine AB",
    fg: "var(--pending)",
    bg: "var(--pending-bg)",
    dot: "var(--pending)",
  },
  pending: {
    label: "Offen",
    fg: "var(--pending)",
    bg: "var(--pending-bg)",
    dot: "var(--pending)",
  },
};

// English status pill keyed by the canonical status strings used across the
// Inbox, Purchase Orders and Drawer.
const STATUS_STYLES: Record<string, { label: string; fg: string; bg: string }> = {
  match: { label: "Confirmed", fg: "var(--ok)", bg: "var(--ok-bg)" },
  confirmed: { label: "Confirmed", fg: "var(--ok)", bg: "var(--ok-bg)" },
  done: { label: "Done", fg: "var(--ok)", bg: "var(--ok-bg)" },
  deviation: { label: "Deviation", fg: "var(--warn)", bg: "var(--warn-bg)" },
  overdue: { label: "Overdue", fg: "var(--overdue)", bg: "var(--overdue-bg)" },
  no_po: { label: "No PO", fg: "var(--pending)", bg: "var(--pending-bg)" },
  open: { label: "Open", fg: "var(--pending)", bg: "var(--pending-bg)" },
  "awaiting confirmation": { label: "Awaiting", fg: "var(--pending)", bg: "var(--pending-bg)" },
  // Matching-spine effective statuses.
  awaiting: { label: "Awaiting", fg: "var(--pending)", bg: "var(--pending-bg)" },
  to_review: { label: "To review", fg: "var(--warn)", bg: "var(--warn-bg)" },
  exported: { label: "Exported", fg: "var(--ok)", bg: "var(--ok-bg)" },
  externally_changed: { label: "Changed in SAP", fg: "var(--overdue)", bg: "var(--overdue-bg)" },
  archived: { label: "Closed", fg: "var(--pending)", bg: "var(--pending-bg)" },
  waiting_import: { label: "Waiting for import", fg: "var(--pending)", bg: "var(--pending-bg)" },
};

export function StatusPill({ status, label }: { status: string; label?: string }) {
  const s = STATUS_STYLES[status] ?? { label: status, fg: "var(--pending)", bg: "var(--pending-bg)" };
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 10px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        color: s.fg,
        backgroundColor: s.bg,
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: 999, backgroundColor: s.fg, display: "inline-block" }} />
      {label ?? s.label}
    </span>
  );
}

export function StatusBadge({
  bucket,
  label,
}: {
  bucket: Bucket;
  label?: string;
}) {
  const s = BUCKET_STYLES[bucket];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 10px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        color: s.fg,
        backgroundColor: s.bg,
        whiteSpace: "nowrap",
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: 999,
          backgroundColor: s.dot,
          display: "inline-block",
        }}
      />
      {label ?? s.label}
    </span>
  );
}
