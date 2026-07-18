import { redirect } from "next/navigation";
import { config } from "@/lib/config";
import { getMatching, type MatchTab } from "@/lib/views";
import { getSession } from "@/lib/auth/server";
import { runWithCompany } from "@/lib/tenant";
import SetupNotice from "@/components/SetupNotice";
import MatchingClient from "@/components/MatchingClient";

export const dynamic = "force-dynamic";

export default async function MatchingPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  if (!config.isConfigured()) return <SetupNotice />;
  const session = await getSession();
  if (!session) redirect("/login");
  const { tab } = await searchParams;

  // Legacy deep links: the old "all" and "done" tabs are now the All POs lens
  // ("done" preselecting the Done status filter).
  let initialTab: MatchTab = "inbox";
  let initialStatus = "";
  if (tab === "orders" || tab === "all") initialTab = "orders";
  else if (tab === "done") {
    initialTab = "orders";
    initialStatus = "done";
  }

  const data = await runWithCompany(session.company.id, () => getMatching());
  return <MatchingClient data={data} initialTab={initialTab} initialStatus={initialStatus} />;
}
