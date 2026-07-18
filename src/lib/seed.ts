import "server-only";
import { randomBytes } from "node:crypto";
import { getSupabase, ensureBucket } from "@/lib/supabase";
import { config } from "@/lib/config";
import { getCompanyId } from "@/lib/tenant";
import { buildPoCsvBytes, buildSampleDocs } from "@/lib/samples";
import { decodeCsv, parseSapCsv } from "@/lib/sap/import";
import { getActiveMapping } from "@/lib/settings";
import { runImport } from "@/lib/store";
import { ingestDocument } from "@/lib/pipeline";
import { DEFAULT_MAPPING } from "@/lib/sap/mapping";

// Demo tenant provisioned by /api/seed so the deployed app has something to log
// into. The password is never a published constant: SEED_DEMO_PASSWORD if set,
// otherwise randomly generated per seed run. Every seed resets the demo user's
// password to the value returned in the seed response (printed by `npm run seed`).
export const DEMO_EMAIL = "demo@example.com";

function demoPassword(): string {
  return process.env.SEED_DEMO_PASSWORD || `demo-${randomBytes(9).toString("base64url")}`;
}

// Wipe THIS COMPANY's business rows for a clean demo re-seed (an explicit
// maintenance op guarded by SEED_TOKEN — distinct from the runtime rule that
// business records are never deleted). Never touches other tenants.
export async function resetAll(): Promise<void> {
  const sb = getSupabase();
  const cid = getCompanyId();
  const tables = [
    "matches",
    "extractions",
    "decisions",
    "chasers",
    "abs",
    "pos",
    "import_runs",
    "export_runs",
  ];
  for (const t of tables) {
    await sb.from(t).delete().eq("company_id", cid);
  }
  await purgeBucket(cid);
}

// Remove this company's objects from the AB-documents bucket (paths are prefixed
// with the company id, see pipeline.ts). Paginates for a large bucket.
async function purgeBucket(companyId: string): Promise<void> {
  const sb = getSupabase();
  const bucket = config.supabase.bucket();
  for (;;) {
    const { data, error } = await sb.storage.from(bucket).list(companyId, { limit: 100 });
    if (error || !data || data.length === 0) return;
    const paths = data.filter((o) => o.name).map((o) => `${companyId}/${o.name}`);
    if (paths.length === 0) return;
    await sb.storage.from(bucket).remove(paths);
    if (data.length < 100) return;
  }
}

export interface SeedResult {
  import: Awaited<ReturnType<typeof runImport>>;
  documents: {
    filename: string;
    docKind: string;
    bucket: string | null;
    poNumber: string | null;
    findings: number;
  }[];
}

// Seed the pre-visit demo state using the REAL pipeline (no fixtures). Must run
// inside runWithCompany().
export async function seedDemo(): Promise<SeedResult> {
  const sb = getSupabase();
  const cid = getCompanyId();
  await ensureBucket();

  // Ensure a default mapping row exists so Settings has something to show.
  const { data: mappingRows } = await sb
    .from("column_mappings")
    .select("id")
    .eq("company_id", cid)
    .limit(1);
  if (!mappingRows || mappingRows.length === 0) {
    await sb.from("column_mappings").insert({
      company_id: cid,
      name: "default",
      delimiter: DEFAULT_MAPPING.delimiter,
      decimal_sep: DEFAULT_MAPPING.decimal_sep,
      date_format: DEFAULT_MAPPING.date_format,
      encoding: DEFAULT_MAPPING.encoding,
      mapping: DEFAULT_MAPPING.mapping,
      is_active: true,
    });
  }

  // 2) Import the SAP PO list.
  const mapping = await getActiveMapping();
  const csvBytes = buildPoCsvBytes();
  const text = decodeCsv(csvBytes, mapping.encoding);
  const parsed = parseSapCsv(text, mapping);
  const importSummary = await runImport(parsed.rows, "SAP_Bestellungen.csv", mapping.mapping);

  // 3) Real extraction over the three sample ABs, concurrently.
  const docs = await buildSampleDocs();
  const abDocs = docs.filter((d) => d.isAb);
  const documents: SeedResult["documents"] = await Promise.all(
    abDocs.map(async (d) => {
      const result = await ingestDocument({
        bytes: d.bytes,
        filename: d.filename,
        mimeType: "application/pdf",
        source: "upload",
        sourceMeta: { seeded: true, sample: d.key },
      });
      return {
        filename: d.filename,
        docKind: result.docKind,
        bucket: result.bucket,
        poNumber: result.poNumber,
        findings: result.match?.positions.reduce((s, p) => s + p.findings.length, 0) ?? 0,
      };
    }),
  );

  return { import: importSummary, documents };
}

// Provision (idempotently) the demo company + owner user, returning its id and
// login credentials. Used by /api/seed, which then seeds data into it.
export async function ensureDemoCompany(): Promise<{
  companyId: string;
  email: string;
  password: string;
}> {
  const admin = getSupabase();
  const password = demoPassword();

  const { data: prof } = await admin
    .from("profiles")
    .select("id, company_id")
    .eq("email", DEMO_EMAIL)
    .limit(1);
  if (prof && prof.length && prof[0].company_id) {
    // Reset the password so the value returned by this seed run is the one
    // that works (and any previously known password stops working).
    await admin.auth.admin.updateUserById(prof[0].id as string, { password });
    return { companyId: prof[0].company_id as string, email: DEMO_EMAIL, password };
  }

  // Create the auth user, or find it if it already exists without a profile.
  let userId: string | null = null;
  const { data: created } = await admin.auth.admin.createUser({
    email: DEMO_EMAIL,
    password,
    email_confirm: true,
    user_metadata: { name: "Günther (Demo)" },
  });
  userId = created?.user?.id ?? null;
  if (!userId) {
    const { data: list } = await admin.auth.admin.listUsers();
    userId = list?.users.find((u) => u.email === DEMO_EMAIL)?.id ?? null;
    if (userId) await admin.auth.admin.updateUserById(userId, { password });
  }
  if (!userId) throw new Error("Could not provision demo user.");

  const { data: company, error: coErr } = await admin
    .from("companies")
    .insert({
      name: "AB Agent Demo GmbH",
      intake_email: "ab-demo@inbound.example.com",
      overdue_days: 3,
      level2_days: 3,
      escalation_days: 3,
    })
    .select("id")
    .single();
  if (coErr || !company) throw new Error("Could not create demo company.");

  await admin.from("profiles").upsert({
    id: userId,
    company_id: company.id,
    name: "Günther (Demo)",
    email: DEMO_EMAIL,
    role: "owner",
  });

  return { companyId: company.id as string, email: DEMO_EMAIL, password };
}
