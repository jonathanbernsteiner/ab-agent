"use server";

import { revalidatePath } from "next/cache";
import { getSession } from "@/lib/auth/server";
import {
  addMember,
  removeMember,
  updateCompany,
  updateProfileName,
} from "@/lib/auth/team";
import { runWithCompany } from "@/lib/tenant";
import { saveDeadlines } from "@/lib/settings";
import { addContact, deleteContact, setDefaultContact } from "@/lib/contacts";

export interface ActionResult {
  ok?: boolean;
  error?: string;
}

export async function updateProfileAction(_p: ActionResult, form: FormData): Promise<ActionResult> {
  const session = await getSession();
  if (!session) return { error: "Nicht angemeldet." };
  await updateProfileName(session.userId, String(form.get("name") ?? ""));
  revalidatePath("/settings");
  return { ok: true };
}

export async function updateCompanyAction(_p: ActionResult, form: FormData): Promise<ActionResult> {
  const session = await getSession();
  if (!session) return { error: "Nicht angemeldet." };
  if (session.profile.role !== "owner") return { error: "Nur der Inhaber darf die Firma bearbeiten." };
  await updateCompany(session.company.id, {
    name: String(form.get("name") ?? session.company.name),
  });
  const overdue = Number(form.get("overdue_days"));
  const level2 = Number(form.get("level2_days"));
  const escalation = Number(form.get("escalation_days"));
  if (Number.isFinite(overdue) && Number.isFinite(level2) && Number.isFinite(escalation)) {
    await runWithCompany(session.company.id, () =>
      saveDeadlines({ overdue_days: overdue, level2_days: level2, escalation_days: escalation }),
    );
  }
  revalidatePath("/settings");
  return { ok: true };
}

export async function addMemberAction(_p: ActionResult, form: FormData): Promise<ActionResult> {
  const session = await getSession();
  if (!session) return { error: "Nicht angemeldet." };
  if (session.profile.role !== "owner") return { error: "Nur der Inhaber darf Nutzer hinzufügen." };
  const res = await addMember({
    companyId: session.company.id,
    email: String(form.get("email") ?? ""),
    password: String(form.get("password") ?? ""),
    name: String(form.get("name") ?? ""),
  });
  if (res.error) return { error: res.error };
  revalidatePath("/settings");
  return { ok: true };
}

export async function removeMemberAction(_p: ActionResult, form: FormData): Promise<ActionResult> {
  const session = await getSession();
  if (!session) return { error: "Nicht angemeldet." };
  if (session.profile.role !== "owner") return { error: "Nur der Inhaber darf Nutzer entfernen." };
  const userId = String(form.get("userId") ?? "");
  if (userId === session.userId) return { error: "Du kannst dich nicht selbst entfernen." };
  const res = await removeMember(session.company.id, userId);
  if (res.error) return { error: res.error };
  revalidatePath("/settings");
  return { ok: true };
}

// ── Supplier contacts (any member may edit — operational data, not admin) ────

export async function addContactAction(_p: ActionResult, form: FormData): Promise<ActionResult> {
  const session = await getSession();
  if (!session) return { error: "Nicht angemeldet." };
  const supplier = String(form.get("supplier") ?? "").trim();
  const email = String(form.get("email") ?? "").trim();
  if (!supplier || !email.includes("@")) return { error: "Lieferant und gültige E-Mail erforderlich." };
  await runWithCompany(session.company.id, () =>
    addContact({ supplier, email, name: String(form.get("name") ?? "").trim() || null }),
  );
  revalidatePath("/contacts");
  return { ok: true };
}

export async function deleteContactAction(_p: ActionResult, form: FormData): Promise<ActionResult> {
  const session = await getSession();
  if (!session) return { error: "Nicht angemeldet." };
  await runWithCompany(session.company.id, () => deleteContact(String(form.get("id") ?? "")));
  revalidatePath("/contacts");
  return { ok: true };
}

export async function setDefaultContactAction(_p: ActionResult, form: FormData): Promise<ActionResult> {
  const session = await getSession();
  if (!session) return { error: "Nicht angemeldet." };
  await runWithCompany(session.company.id, () => setDefaultContact(String(form.get("id") ?? "")));
  revalidatePath("/contacts");
  return { ok: true };
}

// No type re-exports here: in a "use server" module every export becomes a
// registered action at runtime, so `export type { Member }` compiles into a
// re-export of a value that was erased — ReferenceError on module evaluation.
// Import Member from "@/lib/auth/team" instead.
