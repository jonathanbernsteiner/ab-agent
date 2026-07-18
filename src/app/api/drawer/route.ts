import { NextResponse } from "next/server";
import { getDrawer } from "@/lib/views";
import { getSession } from "@/lib/auth/server";
import { runWithCompany } from "@/lib/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/drawer?ab=<abId>  or  ?po=<poNumber>
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const signature = { name: session.profile.name, company: session.company.name };
  return runWithCompany(session.company.id, async () => {
  const url = new URL(req.url);
  const ab = url.searchParams.get("ab");
  const po = url.searchParams.get("po");
  if (!ab && !po) {
    return NextResponse.json({ error: "ab or po required." }, { status: 400 });
  }
  try {
    const data = ab
      ? await getDrawer({ type: "ab", id: ab }, signature)
      : await getDrawer({ type: "po", poNumber: po! }, signature);
    if (!data) return NextResponse.json({ error: "Not found." }, { status: 404 });
    return NextResponse.json(data);
  } catch (err) {
    console.error("[drawer]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error." },
      { status: 500 },
    );
  }
  });
}
