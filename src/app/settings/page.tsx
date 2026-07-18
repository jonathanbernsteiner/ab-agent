import { redirect } from "next/navigation";
import { config } from "@/lib/config";
import SetupNotice from "@/components/SetupNotice";
import SettingsClient from "@/components/SettingsClient";
import { getSession } from "@/lib/auth/server";
import { listMembers } from "@/lib/auth/team";
import { runWithCompany } from "@/lib/tenant";
import { getMailAccounts } from "@/lib/mail/store";
import { allProviders } from "@/lib/mail/providers";

export const dynamic = "force-dynamic";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ mail?: string; reason?: string }>;
}) {
  if (!config.isConfigured()) return <SetupNotice />;
  const session = await getSession();
  if (!session) redirect("/login");

  // OAuth redirect lands on /settings?mail=connected|error&reason=… — surface it.
  const { mail, reason } = await searchParams;
  const mailNotice =
    mail === "connected"
      ? ({ kind: "connected" } as const)
      : mail === "error"
        ? ({ kind: "error", reason } as const)
        : null;

  const members = await listMembers(session.company.id);

  // Mailbox integration state (empty until a mailbox is connected).
  const accounts = await runWithCompany(session.company.id, () => getMailAccounts());

  return (
    <SettingsClient
      profile={{
        name: session.profile.name,
        email: session.email,
        role: session.profile.role,
      }}
      company={{
        name: session.company.name,
        overdueDays: session.company.overdue_days,
        level2Days: session.company.level2_days,
        escalationDays: session.company.escalation_days,
      }}
      members={members}
      isOwner={session.profile.role === "owner"}
      mailNotice={mailNotice}
      integration={{
        providers: allProviders()
          .filter((p) => p.id !== "manual")
          .map((p) => ({ id: p.id, label: p.label, connectable: p.connectable })),
        accounts: accounts.map((a) => ({
          id: a.id,
          provider: a.provider,
          externalEmail: a.externalEmail,
          status: a.status,
          lastPolledAt: a.lastPolledAt ?? null,
          lastError: a.lastError ?? null,
        })),
      }}
    />
  );
}
