import { NextResponse } from "next/server";
import { getActiveMapping, saveMapping } from "@/lib/settings";
import type { ColumnMapping } from "@/lib/sap/mapping";
import { sessionCompanyId } from "@/lib/auth/guard";
import { runWithCompany } from "@/lib/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const companyId = await sessionCompanyId();
  if (!companyId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return runWithCompany(companyId, async () => {
    try {
      const mapping = await getActiveMapping();
      return NextResponse.json(mapping);
    } catch (err) {
      console.error("[settings/mapping:GET]", err);
      return NextResponse.json({ error: "Error." }, { status: 500 });
    }
  });
}

export async function POST(req: Request) {
  const companyId = await sessionCompanyId();
  if (!companyId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return runWithCompany(companyId, async () => {
    try {
      const body = (await req.json()) as ColumnMapping;
      if (!body.mapping || typeof body.mapping !== "object") {
        return NextResponse.json({ error: "mapping erforderlich." }, { status: 400 });
      }
      await saveMapping(body);
      return NextResponse.json({ ok: true });
    } catch (err) {
      console.error("[settings/mapping]", err);
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Fehler." },
        { status: 500 },
      );
    }
  });
}
