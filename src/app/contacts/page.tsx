import { redirect } from "next/navigation";
import { config } from "@/lib/config";
import SetupNotice from "@/components/SetupNotice";
import ContactsClient from "@/components/ContactsClient";
import { getSession } from "@/lib/auth/server";
import { runWithCompany } from "@/lib/tenant";
import { listContacts } from "@/lib/contacts";

export const dynamic = "force-dynamic";

export default async function ContactsPage() {
  if (!config.isConfigured()) return <SetupNotice />;
  const session = await getSession();
  if (!session) redirect("/login");

  const contacts = await runWithCompany(session.company.id, () => listContacts());

  return (
    <ContactsClient
      contacts={contacts.map((c) => ({
        id: c.id,
        supplier: c.supplier,
        name: c.name,
        email: c.email,
        isDefault: c.is_default,
        source: c.source,
      }))}
    />
  );
}
