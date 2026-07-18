import { NextResponse } from "next/server";
import { getDeadlines, saveDeadlines, type Deadlines } from "@/lib/settings";
import { config } from "@/lib/config";
import { sessionCompanyId } from "@/lib/auth/guard";
import { runWithCompany } from "@/lib/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const companyId = await sessionCompanyId();
  if (!companyId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return runWithCompany(companyId, async () => {
    try {
      const deadlines = await getDeadlines();
      return NextResponse.json({ ...deadlines, intakeEmail: config.intakeEmail() });
    } catch (err) {
      console.error("[settings/deadlines:GET]", err);
      return NextResponse.json({ error: "Error." }, { status: 500 });
    }
  });
}

export async function POST(req: Request) {
  const companyId = await sessionCompanyId();
  if (!companyId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return runWithCompany(companyId, async () => {
    try {
      const body = (await req.json()) as Partial<Deadlines>;
      if (typeof body.overdue_days !== "number" || typeof body.level2_days !== "number") {
        return NextResponse.json({ error: "overdue_days and level2_days required." }, { status: 400 });
      }
      // escalation_days is optional so older clients keep working; missing
      // means "keep the current value".
      const current = await getDeadlines();
      await saveDeadlines({
        overdue_days: body.overdue_days,
        level2_days: body.level2_days,
        escalation_days:
          typeof body.escalation_days === "number" ? body.escalation_days : current.escalation_days,
      });
      return NextResponse.json({ ok: true });
    } catch (err) {
      console.error("[settings/deadlines]", err);
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Error." },
        { status: 500 },
      );
    }
  });
}
