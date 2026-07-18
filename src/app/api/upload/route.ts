import { NextResponse } from "next/server";
import { ingestDocument } from "@/lib/pipeline";
import { MAX_UPLOAD_BYTES } from "@/lib/config";
import { rateLimit, clientKey } from "@/lib/ratelimit";
import { sessionCompanyId } from "@/lib/auth/guard";
import { runWithCompany } from "@/lib/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  const companyId = await sessionCompanyId();
  if (!companyId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return runWithCompany(companyId, async () => {
  const rl = await rateLimit(clientKey(req, "upload"), 20);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Zu viele Uploads. Bitte kurz warten." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    );
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
    const files = form.getAll("file").filter((f): f is File => f instanceof File);
    if (files.length === 0) {
      return NextResponse.json({ error: "Keine Datei übermittelt." }, { status: 400 });
    }

    const results = [];
    for (const file of files) {
      if (file.size > MAX_UPLOAD_BYTES) {
        results.push({
          filename: file.name,
          error: `Datei zu groß (max. ${MAX_UPLOAD_BYTES / 1024 / 1024} MB).`,
        });
        continue;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      try {
        const result = await ingestDocument({
          bytes,
          filename: file.name,
          mimeType: file.type || "application/pdf",
          source: "upload",
          sourceMeta: { uploaded_filename: file.name },
        });
        results.push({ filename: file.name, ...result });
      } catch (err) {
        console.error("[upload:ingest]", file.name, err);
        results.push({
          filename: file.name,
          error:
            err instanceof Error
              ? err.message
              : "Verarbeitung fehlgeschlagen.",
        });
      }
    }

    return NextResponse.json({ ok: true, results });
  } catch (err) {
    console.error("[upload]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Upload fehlgeschlagen." },
      { status: 500 },
    );
  }
  });
}
