import { createHash } from "crypto";

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

// Normalize email body text before hashing so a re-forward with trivial
// whitespace/quoting differences still dedupes.
export function normalizeForHash(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}
