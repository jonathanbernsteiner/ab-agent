import { redirect } from "next/navigation";
import { config } from "@/lib/config";
import { getExportRows, getImportHistory, getExportHistory } from "@/lib/store";
import { getSession } from "@/lib/auth/server";
import { runWithCompany } from "@/lib/tenant";
import SetupNotice from "@/components/SetupNotice";
import ImportExportClient from "@/components/ImportExportClient";

export const dynamic = "force-dynamic";

export default async function ImportExportPage() {
  if (!config.isConfigured()) return <SetupNotice />;
  const session = await getSession();
  if (!session) redirect("/login");
  const [exportRows, importHistory, exportHistory] = await runWithCompany(session.company.id, () =>
    Promise.all([getExportRows(), getImportHistory(), getExportHistory()]),
  );
  return (
    <ImportExportClient
      exportRows={exportRows}
      importHistory={importHistory}
      exportHistory={exportHistory}
      intakeEmail={session.company.intake_email ?? config.intakeEmail()}
    />
  );
}
