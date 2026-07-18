import { NextResponse } from "next/server";
import { getExportRows, recordExportRun } from "@/lib/store";
import { buildExportCsv } from "@/lib/sap/export";
import { buildExportXlsx } from "@/lib/sap/xlsx";
import { todayIso } from "@/lib/dates";
import { sessionCompanyId } from "@/lib/auth/guard";
import { runWithCompany } from "@/lib/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Evening export: one row per confirmed PO position (auto + approved).
// GET /api/export           → SAP mass-import CSV
// GET /api/export?format=xlsx → the same data as an Excel workbook
export async function GET(req: Request) {
  const companyId = await sessionCompanyId();
  if (!companyId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const xlsx = new URL(req.url).searchParams.get("format") === "xlsx";
  return runWithCompany(companyId, async () => {
    const rows = await getExportRows();
    const base = `sap-import-${todayIso()}`;
    if (xlsx) {
      const buf = await buildExportXlsx(rows);
      await recordExportRun(`${base}.xlsx`, rows);
      return new Response(buf as BodyInit, {
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="${base}.xlsx"`,
        },
      });
    }
    const csv = buildExportCsv(rows);
    await recordExportRun(`${base}.csv`, rows);
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${base}.csv"`,
      },
    });
  });
}
