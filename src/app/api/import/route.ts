import { NextResponse } from "next/server";
import { decodeCsv, parseSapCsv } from "@/lib/sap/import";
import { parseSapXlsx } from "@/lib/sap/xlsx";
import { getActiveMapping } from "@/lib/settings";
import { runImport } from "@/lib/store";
import { rateLimit, clientKey } from "@/lib/ratelimit";
import { MAX_UPLOAD_BYTES } from "@/lib/config";
import { sessionCompanyId } from "@/lib/auth/guard";
import { runWithCompany } from "@/lib/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const companyId = await sessionCompanyId();
  if (!companyId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return runWithCompany(companyId, async () => {
  const rl = await rateLimit(clientKey(req, "import"), 30);
  if (!rl.ok) {
    return NextResponse.json({ error: "Zu viele Anfragen." }, { status: 429 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    // No/invalid multipart body — a client error, not a server fault.
    return NextResponse.json(
      { error: "Ungültiger Upload (kein Formular-Body)." },
      { status: 400 },
    );
  }

  try {
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Keine Datei übermittelt." }, { status: 400 });
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { error: "Datei zu groß (max. 10 MB)." },
        { status: 413 },
      );
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const mapping = await getActiveMapping();
    const isXlsx =
      /\.xlsx?$/i.test(file.name) ||
      file.type.includes("spreadsheetml") ||
      file.type.includes("ms-excel");
    const parsed = isXlsx
      ? await parseSapXlsx(bytes, mapping)
      : parseSapCsv(decodeCsv(bytes, mapping.encoding), mapping);

    if (parsed.rows.length === 0) {
      return NextResponse.json(
        { error: "Keine Bestellzeilen erkannt.", warnings: parsed.warnings },
        { status: 422 },
      );
    }

    const summary = await runImport(parsed.rows, file.name, mapping.mapping);
    return NextResponse.json({ ok: true, ...summary, warnings: parsed.warnings });
  } catch (err) {
    console.error("[import]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Import fehlgeschlagen." },
      { status: 500 },
    );
  }
  });
}
