import "server-only";
import { cache } from "react";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { config } from "@/lib/config";
import { getSupabase } from "@/lib/supabase";

// A Supabase client bound to the request cookies (anon key, RLS applies). Used
// only for the auth session — all business data goes through the service-role
// client in supabase.ts, scoped by company via the tenant context.
export async function createSupabaseServerClient() {
  const cookieStore = await cookies();
  return createServerClient(
    config.supabase.url(),
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Called from a Server Component (read-only cookies) — the middleware
            // refresh handles writing the rotated session, so this is safe to ignore.
          }
        },
      },
    },
  );
}

export interface Profile {
  id: string;
  company_id: string | null;
  name: string | null;
  email: string | null;
  role: string;
}

export interface Company {
  id: string;
  name: string;
  intake_email: string | null;
  overdue_days: number;
  level2_days: number;
  escalation_days: number;
}

export interface SessionContext {
  userId: string;
  email: string | null;
  profile: Profile;
  company: Company;
}

// The authenticated user plus their profile + company, or null if not signed in.
// Wrapped in React cache() so the root layout, the page, and any nested call in
// the SAME request share ONE auth check + ONE DB query instead of repeating them
// (previously 2-3× getUser network round-trips + 4-6 queries per page). Profile
// and company are fetched in a single joined query.
export const getSession = cache(async (): Promise<SessionContext | null> => {
  const sb = await createSupabaseServerClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return null;

  const admin = getSupabase();
  const { data: profile } = await admin
    .from("profiles")
    .select("id, company_id, name, email, role, companies(id, name, intake_email, overdue_days, level2_days, escalation_days)")
    .eq("id", user.id)
    .limit(1)
    .single();
  if (!profile || !profile.company_id) return null;

  const rel = profile.companies as unknown;
  const company = (Array.isArray(rel) ? rel[0] : rel) as Company | null;
  if (!company) return null;

  return {
    userId: user.id,
    email: user.email ?? null,
    profile: {
      id: profile.id,
      company_id: profile.company_id,
      name: profile.name,
      email: profile.email,
      role: profile.role,
    },
    company,
  };
});
