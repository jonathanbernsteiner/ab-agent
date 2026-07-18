import { NextResponse } from "next/server";
import { buildSampleDocs, buildPoCsvBytes } from "@/lib/samples";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/samples            -> JSON list of downloadable sample documents
// GET /api/samples?doc=po     -> the sample SAP PO CSV
// GET /api/samples?doc=<key>  -> a sample AB PDF (metalltech|hartmann|vogel|flyer)
export async function GET(req: Request) {
  try {
  const doc = new URL(req.url).searchParams.get("doc");
  const docs = await buildSampleDocs();

  if (!doc) {
    return NextResponse.json({
      po: { doc: "po", filename: "SAP_Bestellungen.csv", title: "SAP-Bestellliste (CSV)" },
      documents: docs.map((d) => ({
        doc: d.key,
        filename: d.filename,
        title: d.title,
        supplier: d.supplier,
        poNumber: d.poNumber,
        isAb: d.isAb,
      })),
    });
  }

  if (doc === "po") {
    const bytes = buildPoCsvBytes();
    return new Response(bytes as BodyInit, {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": 'attachment; filename="SAP_Bestellungen.csv"',
      },
    });
  }

  const found = docs.find((d) => d.key === doc);
  if (!found) {
    return NextResponse.json({ error: "Unbekanntes Beispiel." }, { status: 404 });
  }
  return new Response(found.bytes as BodyInit, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${found.filename}"`,
    },
  });
  } catch (err) {
    console.error("[samples:GET]", err);
    return NextResponse.json({ error: "Error." }, { status: 500 });
  }
}
