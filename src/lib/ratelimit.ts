import "server-only";
import { getSupabase } from "@/lib/supabase";

// Shared, atomic rate limiter backed by Postgres (the rate_limit_hit RPC), so a
// limit holds across all serverless instances — unlike a per-process Map, which
// each cold instance resets. Fails OPEN if the limiter itself errors: a limiter
// outage must not take down legitimate traffic.
export async function rateLimit(
  key: string,
  limit = 20,
  windowSeconds = 60,
): Promise<{ ok: boolean; remaining: number; retryAfter: number }> {
  try {
    const sb = getSupabase();
    const { data, error } = await sb.rpc("rate_limit_hit", {
      p_bucket: key,
      p_limit: limit,
      p_window_seconds: windowSeconds,
    });
    if (error || !Array.isArray(data) || data.length === 0) {
      return { ok: true, remaining: limit, retryAfter: 0 };
    }
    const row = data[0] as { allowed: boolean; remaining: number; reset_at: string };
    const retryAfter = row.allowed
      ? 0
      : Math.max(1, Math.ceil((new Date(row.reset_at).getTime() - Date.now()) / 1000));
    return { ok: row.allowed, remaining: row.remaining, retryAfter };
  } catch {
    return { ok: true, remaining: limit, retryAfter: 0 };
  }
}

export function clientKey(req: Request, tag: string): string {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "local";
  return `${tag}:${ip}`;
}
