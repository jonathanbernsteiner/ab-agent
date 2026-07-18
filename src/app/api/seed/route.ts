import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { seedDemo, resetAll, ensureDemoCompany } from "@/lib/seed";
import { runWithCompany } from "@/lib/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// POST /api/seed?token=...&reset=1
// Guarded by SEED_TOKEN. `reset=1` wipes business tables first, then seeds the
// demo state by running the real extraction pipeline over the sample documents.
export async function POST(req: Request) {
  const token = config.seedToken();
  const url = new URL(req.url);
  // Fail closed: /api/seed can WIPE all business data (reset=1). If no SEED_TOKEN
  // is configured, the endpoint is disabled outright rather than left open — an
  // unauthenticated public deploy must never expose a data-wipe. Set SEED_TOKEN
  // to enable seeding (locally and on Vercel).
  if (!token) {
    return NextResponse.json(
      { error: "Seeding is disabled. Set SEED_TOKEN to enable it." },
      { status: 403 },
    );
  }
  if (url.searchParams.get("token") !== token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Provision (idempotently) the demo company + owner login, then seed into it.
    const demo = await ensureDemoCompany();
    const reset = url.searchParams.get("reset") === "1";
    const result = await runWithCompany(demo.companyId, async () => {
      if (reset) await resetAll();
      return seedDemo();
    });
    return NextResponse.json({
      ok: true,
      demo: { email: demo.email, password: demo.password },
      ...result,
    });
  } catch (err) {
    console.error("[seed]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Seed fehlgeschlagen." },
      { status: 500 },
    );
  }
}
