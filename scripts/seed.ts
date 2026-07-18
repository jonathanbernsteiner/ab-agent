/*
 * Seed the demo state by driving the REAL pipeline through the running app.
 *
 * We call the /api/seed endpoint (rather than importing the server modules
 * directly) so the seed runs in the same server context as production — real
 * Anthropic extraction, real Supabase writes, no fixtures.
 *
 *   1. start the app:   npm run dev   (or deploy)
 *   2. run the seed:     npm run seed
 *
 * Config (from .env.local, loaded best-effort below):
 *   SEED_TOKEN       guards the endpoint
 *   SEED_BASE_URL    where the app runs (default http://localhost:3000)
 */
import { readFileSync } from "fs";
import { resolve } from "path";

function loadDotenv(file: string) {
  try {
    const text = readFileSync(resolve(process.cwd(), file), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch {
    /* no .env.local — rely on the ambient environment */
  }
}

async function main() {
  loadDotenv(".env.local");
  const baseUrl = process.env.SEED_BASE_URL || "http://localhost:3000";
  const token = process.env.SEED_TOKEN || "";
  const url = `${baseUrl}/api/seed?reset=1${token ? `&token=${encodeURIComponent(token)}` : ""}`;

  console.log(`→ Seeding via ${baseUrl}/api/seed (reset) …`);
  console.log("  This runs real extraction on 3 sample ABs — expect ~10–30s.");

  const res = await fetch(url, { method: "POST" });
  const body = await res.text();
  if (!res.ok) {
    console.error(`✗ Seed failed (${res.status}): ${body}`);
    console.error("  Is the app running? Is SEED_TOKEN correct in .env.local?");
    process.exit(1);
  }

  const data = JSON.parse(body);
  console.log("✓ Seed complete.");
  console.log(`  Import: ${data.import.inserted} PO lines.`);
  for (const d of data.documents) {
    console.log(
      `  ${d.filename} → ${d.docKind}/${d.bucket ?? "-"} (PO ${d.poNumber ?? "-"}, ${d.findings} findings)`,
    );
  }
  if (data.demo) {
    console.log(`  Demo login: ${data.demo.email} / ${data.demo.password}`);
    console.log("  (password is regenerated on every seed; set SEED_DEMO_PASSWORD to pin it)");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
