// Shared test harness: locate fixtures and install a fresh in-memory Supabase
// before each test so the real pipeline (store/import/matching) runs offline.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { __setTestSupabaseClient } from "@/lib/supabase";
import { __setTestCompanyId } from "@/lib/tenant";
import { FakeSupabase } from "./fake-supabase";

// A fixed tenant for the offline suite so store/readmodel/views (which scope by
// company) resolve without a request context.
export const TEST_COMPANY_ID = "test-company-0000";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, "..", "..");
export const FIXTURES = join(REPO_ROOT, "fixtures");

export function fixturePath(rel: string): string {
  return join(FIXTURES, rel);
}
export function readFixtureBytes(rel: string): Uint8Array {
  return new Uint8Array(readFileSync(fixturePath(rel)));
}
export function readFixtureText(rel: string): string {
  return readFileSync(fixturePath(rel), "utf-8");
}
export function readFixtureJson<T = unknown>(rel: string): T {
  return JSON.parse(readFixtureText(rel)) as T;
}

// Install a clean store for one test and return it for direct inspection.
export function installFakeDb(): FakeSupabase {
  const db = new FakeSupabase();
  __setTestSupabaseClient(db as unknown as SupabaseClient);
  __setTestCompanyId(TEST_COMPANY_ID);
  return db;
}

export const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY;
