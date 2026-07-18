import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";

// Per-request tenant context. Every DB read/write in store.ts / readmodel.ts /
// pipeline.ts is scoped to the company set here, so the service-role client (which
// bypasses RLS) still enforces isolation. Set it once at the route/entry boundary
// with runWithCompany(); the store layer reads it via getCompanyId().
const store = new AsyncLocalStorage<string>();

// Tests (and other non-request callers) set a default company instead of wrapping
// every call in runWithCompany().
let testDefault: string | null = null;
export function __setTestCompanyId(id: string | null): void {
  testDefault = id;
}

export function runWithCompany<T>(companyId: string, fn: () => T): T {
  return store.run(companyId, fn);
}

export function getCompanyId(): string {
  const id = store.getStore() ?? testDefault;
  if (!id) {
    throw new Error(
      "No company context. This operation must run inside runWithCompany().",
    );
  }
  return id;
}

export function getCompanyIdOrNull(): string | null {
  return store.getStore() ?? testDefault;
}
