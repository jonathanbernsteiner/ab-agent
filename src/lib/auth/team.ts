import "server-only";
import { getSupabase } from "@/lib/supabase";

export interface Member {
  id: string;
  name: string | null;
  email: string | null;
  role: string;
}

// All users belonging to a company.
export async function listMembers(companyId: string): Promise<Member[]> {
  const admin = getSupabase();
  const { data } = await admin
    .from("profiles")
    .select("id, name, email, role")
    .eq("company_id", companyId)
    .order("created_at", { ascending: true });
  return (data ?? []) as Member[];
}

// Add a teammate to a company: create the auth user (pre-confirmed) + profile.
export async function addMember(args: {
  companyId: string;
  email: string;
  password: string;
  name: string;
}): Promise<{ error?: string }> {
  const admin = getSupabase();
  const email = args.email.trim().toLowerCase();
  if (!email || args.password.length < 8) {
    return { error: "E-Mail und ein Passwort (min. 8 Zeichen) erforderlich." };
  }

  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    password: args.password,
    email_confirm: true,
    user_metadata: { name: args.name },
  });
  if (error || !created.user) {
    return {
      error: /already|registered|exist/i.test(error?.message ?? "")
        ? "Diese E-Mail ist bereits registriert."
        : "Nutzer konnte nicht angelegt werden.",
    };
  }

  const { error: prErr } = await admin.from("profiles").insert({
    id: created.user.id,
    company_id: args.companyId,
    name: args.name || null,
    email,
    role: "member",
  });
  if (prErr) {
    await admin.auth.admin.deleteUser(created.user.id);
    return { error: "Profil konnte nicht angelegt werden." };
  }
  return {};
}

// Remove a teammate (owners cannot be removed here; the caller enforces that the
// actor is an owner and isn't removing themselves).
export async function removeMember(companyId: string, userId: string): Promise<{ error?: string }> {
  const admin = getSupabase();
  const { data: target } = await admin
    .from("profiles")
    .select("id, role, company_id")
    .eq("id", userId)
    .limit(1)
    .single();
  if (!target || target.company_id !== companyId) return { error: "Nutzer nicht gefunden." };
  if (target.role === "owner") return { error: "Inhaber kann nicht entfernt werden." };
  await admin.auth.admin.deleteUser(userId); // cascades to the profile row
  return {};
}

export async function updateProfileName(userId: string, name: string): Promise<void> {
  const admin = getSupabase();
  await admin.from("profiles").update({ name: name.trim() || null }).eq("id", userId);
}

export async function updateCompany(
  companyId: string,
  fields: { name?: string; intake_email?: string },
): Promise<void> {
  const admin = getSupabase();
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof fields.name === "string") patch.name = fields.name.trim();
  if (typeof fields.intake_email === "string") {
    patch.intake_email = fields.intake_email.trim().toLowerCase() || null;
  }
  await admin.from("companies").update(patch).eq("id", companyId);
}
