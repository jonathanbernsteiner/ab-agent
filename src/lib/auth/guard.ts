import "server-only";
import { getSession } from "@/lib/auth/server";
import { getSupabase } from "@/lib/supabase";

// The current user's company id, or null if unauthenticated. Route handlers use
// this to return 401; pages redirect to /login. Wrap all data access in
// runWithCompany(companyId, ...) so store.ts / readmodel.ts / views.ts scope to
// the tenant.
export async function sessionCompanyId(): Promise<string | null> {
  const session = await getSession();
  return session?.company.id ?? null;
}

export { getSession };

// Resolve which company an inbound email belongs to, by matching the recipient
// address against companies.intake_email. Falls back to the sole company if only
// one exists (single-tenant deploy). Returns null if it can't be determined.
export async function resolveCompanyByIntake(
  recipients: (string | null | undefined)[],
): Promise<string | null> {
  const admin = getSupabase();
  const addrs = recipients
    .filter((r): r is string => !!r)
    .flatMap((r) => extractEmails(r))
    .map((a) => a.toLowerCase());

  if (addrs.length) {
    const { data } = await admin
      .from("companies")
      .select("id, intake_email")
      .in("intake_email", addrs)
      .limit(1);
    if (data && data.length) return data[0].id as string;
  }

  // Single-tenant fallback: if there's exactly one company, use it.
  const { data: all } = await admin.from("companies").select("id").limit(2);
  if (all && all.length === 1) return all[0].id as string;
  return null;
}

function extractEmails(s: string): string[] {
  const matches = s.match(/[^\s<>@,;]+@[^\s<>@,;]+/g);
  return matches ?? [];
}
