"use server";

import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/auth/server";
import { getSupabase } from "@/lib/supabase";

export interface AuthResult {
  error?: string;
}

// Sign in with email + password. On success the session cookie is set and we
// redirect; on failure we return a message for the form to show.
export async function signInAction(_prev: AuthResult, formData: FormData): Promise<AuthResult> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/matching") || "/matching";
  if (!email || !password) return { error: "E-Mail und Passwort erforderlich." };

  const sb = await createSupabaseServerClient();
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) return { error: "E-Mail oder Passwort ist falsch." };
  redirect(next.startsWith("/") ? next : "/matching");
}

// Sign up: create the auth user (pre-confirmed), a new company, and an owner
// profile, then sign in. The first user of a company is its owner.
export async function signUpAction(_prev: AuthResult, formData: FormData): Promise<AuthResult> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const companyName = String(formData.get("company") ?? "").trim();
  if (!email || !password || !companyName) {
    return { error: "Firma, E-Mail und Passwort erforderlich." };
  }
  if (password.length < 8) return { error: "Passwort muss mindestens 8 Zeichen haben." };

  const admin = getSupabase();

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { name },
  });
  if (createErr || !created.user) {
    const msg = createErr?.message ?? "";
    return {
      error: /already|registered|exist/i.test(msg)
        ? "Diese E-Mail ist bereits registriert."
        : "Konto konnte nicht erstellt werden.",
    };
  }
  const userId = created.user.id;

  const { data: company, error: coErr } = await admin
    .from("companies")
    .insert({
      name: companyName,
      intake_email: `ab-${userId.slice(0, 8)}@inbound.example.com`,
      overdue_days: 3,
      level2_days: 3,
      escalation_days: 3,
    })
    .select("id")
    .single();
  if (coErr || !company) {
    await admin.auth.admin.deleteUser(userId); // roll back the orphan auth user
    return { error: "Firma konnte nicht angelegt werden." };
  }

  const { error: prErr } = await admin.from("profiles").insert({
    id: userId,
    company_id: company.id,
    name: name || null,
    email,
    role: "owner",
  });
  if (prErr) {
    await admin.auth.admin.deleteUser(userId);
    return { error: "Profil konnte nicht angelegt werden." };
  }

  const sb = await createSupabaseServerClient();
  await sb.auth.signInWithPassword({ email, password });
  redirect("/matching");
}

export async function signOutAction(): Promise<void> {
  const sb = await createSupabaseServerClient();
  await sb.auth.signOut();
  redirect("/login");
}
