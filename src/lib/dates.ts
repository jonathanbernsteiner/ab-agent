// Date handling: German formats, ISO week ("KW 31") resolution, and a
// business-day overdue clock. Everything internal is ISO yyyy-mm-dd strings.

// Parse the many shapes an AB or SAP export throws at us into ISO yyyy-mm-dd.
// Returns null if unparseable. Handles:
//   31.07.2026 / 31.7.26        (German)
//   2026-07-31                  (ISO)
//   31/07/2026                  (slash)
//   "KW 31" / "KW31 2026"       (calendar week -> Friday, see resolveCalendarWeek)
export function parseDate(input: string | null | undefined, refYear?: number): string | null {
  if (!input) return null;
  const s = String(input).trim();
  if (!s) return null;

  // ISO already
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const [, y, m, d] = iso;
    return isRealDate(+y, +m, +d) ? s : null;
  }

  // Calendar week
  const kw = s.match(/\bKW\s*(\d{1,2})(?:\s*[/\s]\s*(\d{2,4}))?/i);
  if (kw) {
    const week = parseInt(kw[1], 10);
    // ISO years have 52 or 53 weeks; anything outside is a typo, not week 99.
    if (week < 1 || week > 53) return null;
    const year = kw[2] ? normalizeYear(parseInt(kw[2], 10)) : refYear ?? parseInt(todayIso().slice(0, 4), 10);
    return resolveCalendarWeek(week, year);
  }

  // dd.mm.yyyy or dd/mm/yyyy or dd-mm-yyyy
  const dmy = s.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})$/);
  if (dmy) {
    const day = parseInt(dmy[1], 10);
    const month = parseInt(dmy[2], 10);
    const year = normalizeYear(parseInt(dmy[3], 10));
    return toIso(year, month, day);
  }

  return null;
}

function normalizeYear(y: number): number {
  if (y < 100) return y >= 70 ? 1900 + y : 2000 + y;
  return y;
}

function toIso(year: number, month: number, day: number): string | null {
  if (!isRealDate(year, month, day)) return null;
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

// True only for a real calendar date: rejects month 13, Feb 31, Apr 31, etc.
// (a typo'd AB/SAP date must become null, not an impossible ISO string that
// then flows into the DB and the export CSV).
function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  );
}

// ISO week → the Friday of that week (the spec's rule for "KW 31" → Friday).
export function resolveCalendarWeek(week: number, year: number): string {
  // ISO 8601: week 1 contains the first Thursday. Monday of week 1:
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Dow = jan4.getUTCDay() || 7; // 1..7, Monday=1
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - (jan4Dow - 1));
  const friday = new Date(week1Monday);
  friday.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7 + 4); // +4 = Friday
  return isoOf(friday);
}

function isoOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// German display: 31.07.2026
export function formatDe(iso: string | null | undefined): string {
  if (!iso) return "–";
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  return `${m[3]}.${m[2]}.${m[1]}`;
}

const EN_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// English short display: "Jul 29" (or "Jul 29, 2026" with year).
export function formatEn(iso: string | null | undefined, withYear = false): string {
  if (!iso) return "–";
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  const month = EN_MONTHS[parseInt(m[2], 10) - 1] ?? m[2];
  const day = parseInt(m[3], 10);
  return withYear ? `${month} ${day}, ${m[1]}` : `${month} ${day}`;
}

// Difference in whole days (b - a), both ISO. Positive => b is later.
export function dayDelta(a: string, b: string): number {
  const da = Date.parse(a + "T00:00:00Z");
  const db = Date.parse(b + "T00:00:00Z");
  return Math.round((db - da) / 86400000);
}

// Add N business days (Mon–Fri) to an ISO date; returns ISO.
export function addBusinessDays(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  let added = 0;
  while (added < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return isoOf(d);
}

// Count business days between two ISO dates (from exclusive, to inclusive).
export function businessDaysBetween(fromIso: string, toIso: string): number {
  if (dayDelta(fromIso, toIso) <= 0) return 0;
  const d = new Date(fromIso + "T00:00:00Z");
  const end = new Date(toIso + "T00:00:00Z");
  let count = 0;
  while (d < end) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}

// The business runs on Philippine time. "Today" (overdue clock, snooze
// anchors, chaser deadlines) and timestamp→date labels are computed in this
// timezone, not the server's (UTC on Vercel) or the viewer's.
export const APP_TIMEZONE = "Asia/Manila";

// en-CA formats as yyyy-mm-dd, which is exactly our internal ISO shape.
const appTzDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: APP_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

// The ISO yyyy-mm-dd a timestamp falls on in APP_TIMEZONE. Use this instead
// of `.slice(0, 10)` on UTC timestamps, which is a day early before 8am.
export function isoDateOf(timestamp: string | number | Date): string {
  return appTzDate.format(new Date(timestamp));
}

export function todayIso(): string {
  return isoDateOf(new Date());
}
