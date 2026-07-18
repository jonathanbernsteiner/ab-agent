import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "@/lib/config";

// Server-only service-role client. Bypasses RLS — never import this into a
// client component. `import "server-only"` would throw if it ever were.
import "server-only";

let cached: SupabaseClient | null = null;
let testClient: SupabaseClient | null = null;

// Test-only seam: inject an in-memory client so the real store/import/matching
// logic can run against fixtures without a live Supabase. Never called in prod.
export function __setTestSupabaseClient(client: SupabaseClient | null): void {
  testClient = client;
  cached = null;
}

export function getSupabase(): SupabaseClient {
  if (testClient) return testClient;
  if (cached) return cached;
  cached = createClient(config.supabase.url(), config.supabase.serviceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}

// Ensure the storage bucket for original AB documents exists (idempotent).
export async function ensureBucket(): Promise<void> {
  const sb = getSupabase();
  const bucket = config.supabase.bucket();
  const { data } = await sb.storage.getBucket(bucket);
  if (!data) {
    await sb.storage.createBucket(bucket, { public: false });
  }
}

// Upload the original document bytes; returns the storage path.
export async function storeDocument(
  path: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<string> {
  const sb = getSupabase();
  const bucket = config.supabase.bucket();
  await ensureBucket();
  const { error } = await sb.storage.from(bucket).upload(path, bytes, {
    contentType,
    upsert: true,
  });
  if (error) throw error;
  return path;
}

// A short-lived signed URL to view the original document.
export async function signedDocumentUrl(
  path: string,
  expiresInSeconds = 3600,
): Promise<string | null> {
  const sb = getSupabase();
  const bucket = config.supabase.bucket();
  const { data, error } = await sb.storage
    .from(bucket)
    .createSignedUrl(path, expiresInSeconds);
  if (error) return null;
  return data.signedUrl;
}
