import { NextResponse } from "next/server";
import { recordDecision, acceptAllForAb } from "@/lib/store";
import { sessionCompanyId } from "@/lib/auth/guard";
import { runWithCompany } from "@/lib/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Deviation decisions: accept (queues the supplier's values), accept_all (every
// deviating line on the AB), escalate (hands off to a human), or pushback
// (logged; card stays open). Decisions are per line item.
interface Body {
  poNumber?: string;
  position?: number | null;
  abId?: string | null;
  kind?: "accept" | "accept_all" | "escalate" | "pushback";
  confirmedDate?: string | null;
  confirmedQty?: number | null;
  confirmedPrice?: number | null;
  payload?: Record<string, unknown>;
}

export async function POST(req: Request) {
  const companyId = await sessionCompanyId();
  if (!companyId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return runWithCompany(companyId, async () => {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Ungültiges JSON." }, { status: 400 });
  }

  if (!body.kind) {
    return NextResponse.json({ error: "kind required." }, { status: 400 });
  }

  try {
    if (body.kind === "accept_all") {
      if (!body.abId) {
        return NextResponse.json({ error: "abId required for accept_all." }, { status: 400 });
      }
      const count = await acceptAllForAb(body.abId);
      return NextResponse.json({ ok: true, accepted: count });
    }

    if (!body.poNumber) {
      return NextResponse.json({ error: "poNumber required." }, { status: 400 });
    }

    await recordDecision({
      poNumber: body.poNumber,
      position: body.position ?? null,
      abId: body.abId ?? null,
      kind: body.kind,
      confirmedDate: body.confirmedDate ?? null,
      confirmedQty: body.confirmedQty ?? null,
      confirmedPrice: body.confirmedPrice ?? null,
      payload: body.payload,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[decisions]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Fehler." },
      { status: 500 },
    );
  }
  });
}
