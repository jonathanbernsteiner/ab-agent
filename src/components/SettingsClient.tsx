"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { User, Building2, Users, Check, Loader2, Trash2, Plug, Mail, Unplug, RefreshCw } from "lucide-react";
import { Panel } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { APP_TIMEZONE } from "@/lib/dates";
import {
  updateProfileAction,
  updateCompanyAction,
  addMemberAction,
  removeMemberAction,
  type ActionResult,
} from "@/lib/auth/settings-actions";
import type { Member } from "@/lib/auth/team";

export interface IntegrationProps {
  providers: { id: string; label: string; connectable: boolean }[];
  accounts: {
    id: string;
    provider: string;
    externalEmail: string | null;
    status: string;
    lastPolledAt: string | null;
    lastError: string | null;
  }[];
}

interface Props {
  profile: { name: string | null; email: string | null; role: string };
  company: { name: string; overdueDays: number; level2Days: number; escalationDays: number };
  members: Member[];
  isOwner: boolean;
  integration: IntegrationProps;
  // Set after the OAuth redirect lands back on /settings?mail=… — opens the
  // Integrations section with a success/error notice.
  mailNotice?: { kind: "connected" | "error"; reason?: string } | null;
}

type Section = "profile" | "company" | "team" | "integrations";

const SECTIONS: { key: Section; label: string; icon: React.ReactNode }[] = [
  { key: "profile", label: "Profile", icon: <User size={16} /> },
  { key: "company", label: "Company", icon: <Building2 size={16} /> },
  { key: "team", label: "Team", icon: <Users size={16} /> },
  { key: "integrations", label: "Integrations", icon: <Plug size={16} /> },
];

export default function SettingsClient({ profile, company, members, isOwner, integration, mailNotice }: Props) {
  const [section, setSection] = useState<Section>(mailNotice ? "integrations" : "profile");

  return (
    <div style={{ display: "flex", minHeight: "calc(100vh - 56px)" }}>
      {/* section rail */}
      <nav style={{ width: 220, borderRight: "1px solid #E2E8F0", background: "#F5F5F5", padding: "20px 10px" }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "#94A3B8", letterSpacing: 1, textTransform: "uppercase", padding: "0 8px 10px" }}>
          Settings
        </div>
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            onClick={() => setSection(s.key)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              width: "100%",
              padding: "9px 10px",
              marginBottom: 2,
              borderRadius: 8,
              border: "none",
              cursor: "pointer",
              fontSize: 14,
              textAlign: "left",
              color: section === s.key ? "#0F172A" : "#64748B",
              background: section === s.key ? "#FFFFFF" : "transparent",
              borderLeft: section === s.key ? "2px solid #3D38FF" : "2px solid transparent",
              fontWeight: section === s.key ? 600 : 500,
              boxShadow: section === s.key ? "0 1px 3px rgba(15,23,42,0.06)" : "none",
            }}
          >
            {s.icon}
            {s.label}
          </button>
        ))}
      </nav>

      <div style={{ flex: 1, padding: 32, maxWidth: 720 }}>
        {section === "profile" && <ProfileSection profile={profile} />}
        {section === "company" && <CompanySection company={company} isOwner={isOwner} />}
        {section === "team" && <TeamSection members={members} isOwner={isOwner} />}
        {section === "integrations" && <IntegrationsSection integration={integration} isOwner={isOwner} notice={mailNotice ?? null} />}
      </div>
    </div>
  );
}

function ProfileSection({ profile }: { profile: Props["profile"] }) {
  const [state, action, pending] = useActionState<ActionResult, FormData>(updateProfileAction, {});
  return (
    <>
      <h2 style={h2}>Your profile</h2>
      <p style={sub}>This name appears on decisions and in the top bar.</p>
      <Panel style={{ padding: 20, maxWidth: 460 }}>
        <form action={action}>
          <label style={label}>Name</label>
          <input name="name" defaultValue={profile.name ?? ""} style={input} />
          <label style={label}>Email</label>
          <input value={profile.email ?? ""} disabled style={{ ...input, background: "#F1F5F9", color: "#64748B" }} />
          <div style={{ marginTop: 8, fontSize: 12, color: "#94A3B8" }}>Role: {profile.role}</div>
          <div style={{ marginTop: 16 }}>
            <SaveButton pending={pending} ok={state.ok} />
          </div>
        </form>
      </Panel>
    </>
  );
}

function CompanySection({ company, isOwner }: { company: Props["company"]; isOwner: boolean }) {
  const [state, action, pending] = useActionState<ActionResult, FormData>(updateCompanyAction, {});
  return (
    <>
      <h2 style={h2}>Company</h2>
      <p style={sub}>Company details and overdue deadlines.</p>
      <Panel style={{ padding: 20, maxWidth: 620 }}>
        <form action={action}>
          <label style={label}>Company name</label>
          <input name="name" defaultValue={company.name} disabled={!isOwner} style={input} />

          <div style={{ display: "flex", gap: 16, marginTop: 16 }}>
            <div style={{ flex: 1 }}>
              <label style={label}>Overdue after (business days)</label>
              <input name="overdue_days" type="number" min={0} defaultValue={company.overdueDays} disabled={!isOwner} style={input} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={label}>2nd reminder after (more days)</label>
              <input name="level2_days" type="number" min={0} defaultValue={company.level2Days} disabled={!isOwner} style={input} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={label}>Escalation after (more days)</label>
              <input name="escalation_days" type="number" min={0} defaultValue={company.escalationDays} disabled={!isOwner} style={input} />
            </div>
          </div>

          {state.error && <p style={err}>{state.error}</p>}
          {isOwner ? (
            <div style={{ marginTop: 16 }}>
              <SaveButton pending={pending} ok={state.ok} />
            </div>
          ) : (
            <p style={{ ...sub, marginTop: 14 }}>Only the owner can change company settings.</p>
          )}
        </form>
      </Panel>
    </>
  );
}

function TeamSection({ members, isOwner }: { members: Member[]; isOwner: boolean }) {
  const [addState, addAction, adding] = useActionState<ActionResult, FormData>(addMemberAction, {});
  const [rmState, rmAction] = useActionState<ActionResult, FormData>(removeMemberAction, {});
  return (
    <>
      <h2 style={h2}>Team</h2>
      <p style={sub}>People in your company who can use AB Agent.</p>

      <Panel style={{ padding: 0, maxWidth: 560, overflow: "hidden" }}>
        {members.map((m, i) => (
          <div
            key={m.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "12px 16px",
              borderTop: i === 0 ? "none" : "1px solid #EEF1F6",
            }}
          >
            <div style={{ width: 30, height: 30, borderRadius: "50%", background: "#3D38FF", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 600 }}>
              {(m.name || m.email || "?").charAt(0).toUpperCase()}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 500, color: "#0F172A" }}>{m.name || m.email}</div>
              <div style={{ fontSize: 12, color: "#94A3B8" }}>{m.email}</div>
            </div>
            <span style={{ fontSize: 11, fontWeight: 600, color: m.role === "owner" ? "#3D38FF" : "#94A3B8", textTransform: "uppercase" }}>{m.role}</span>
            {isOwner && m.role !== "owner" && (
              <form action={rmAction}>
                <input type="hidden" name="userId" value={m.id} />
                <button type="submit" title="Remove" style={{ border: "none", background: "transparent", cursor: "pointer", color: "#DC2626", display: "flex" }}>
                  <Trash2 size={16} />
                </button>
              </form>
            )}
          </div>
        ))}
      </Panel>
      {rmState.error && <p style={err}>{rmState.error}</p>}

      {isOwner && (
        <Panel style={{ padding: 20, maxWidth: 560, marginTop: 18 }}>
          <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0, marginBottom: 12 }}>Add a teammate</h3>
          <form action={addAction}>
            <div style={{ display: "flex", gap: 12 }}>
              <div style={{ flex: 1 }}>
                <label style={label}>Name</label>
                <input name="name" style={input} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={label}>Email</label>
                <input name="email" type="email" required style={input} />
              </div>
            </div>
            <label style={label}>Temporary password (min. 8 chars)</label>
            <input name="password" type="text" required minLength={8} style={input} placeholder="They can change it later" />
            {addState.error && <p style={err}>{addState.error}</p>}
            <div style={{ marginTop: 14 }}>
              <Button size="sm" disabled={adding}>
                {adding ? <Loader2 className="animate-spin" size={15} /> : null} Add teammate
              </Button>
            </div>
          </form>
        </Panel>
      )}
    </>
  );
}

// Connect URLs per provider — only Gmail is live today.
const CONNECT_URL: Record<string, string> = { gmail: "/api/mail/connect/google" };

const ERROR_TEXT: Record<string, string> = {
  denied: "Google access was declined. Try again and allow both permissions.",
  state: "The sign-in flow expired or was tampered with. Try again.",
  exchange: "Google rejected the connection. Check the OAuth client configuration and try again.",
  owner_only: "Only the owner can connect a mailbox.",
  not_configured: "Gmail is not configured on the server (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).",
};

function IntegrationsSection({ integration, isOwner, notice }: { integration: IntegrationProps; isOwner: boolean; notice: Props["mailNotice"] }) {
  const { providers, accounts } = integration;
  const router = useRouter();
  const active = accounts.filter((a) => a.status === "connected" || a.status === "error");
  const [busy, setBusy] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState<string | null>(null);

  async function syncNow() {
    setSyncing(true);
    setSyncNote(null);
    try {
      const res = await fetch("/api/mail/sync", { method: "POST" });
      const data = (await res.json()) as { summaries?: { fetched: number; ingested: number; error?: string }[]; error?: string };
      if (!res.ok) {
        setSyncNote(data.error ?? "Sync failed.");
      } else {
        const fetched = (data.summaries ?? []).reduce((n, s) => n + s.fetched, 0);
        const ingested = (data.summaries ?? []).reduce((n, s) => n + s.ingested, 0);
        const failed = (data.summaries ?? []).some((s) => s.error);
        setSyncNote(
          failed
            ? "Sync failed — see the mailbox status below."
            : fetched === 0
              ? "Synced — no new mail."
              : `Synced — ${fetched} new email${fetched === 1 ? "" : "s"} read, ${ingested} order${ingested === 1 ? "" : "s"} picked up.`,
        );
      }
      router.refresh();
    } catch {
      setSyncNote("Sync failed.");
    } finally {
      setSyncing(false);
    }
  }

  async function disconnect(accountId: string) {
    setBusy(accountId);
    try {
      await fetch("/api/mail/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId }),
      });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <h2 style={h2}>Integrations</h2>
      <p style={sub}>
        Connect a mailbox and AB Agent reads every incoming email, decides whether
        it&apos;s an order confirmation, and only runs the full extraction on the ones that are —
        everything else is skipped. Pushback and chaser emails send from the same mailbox.
      </p>

      {notice && (
        <div
          style={{
            padding: "10px 14px",
            borderRadius: 8,
            marginBottom: 14,
            fontSize: 13,
            maxWidth: 620,
            background: notice.kind === "connected" ? "#DCFCE7" : "#FEE2E2",
            color: notice.kind === "connected" ? "#166534" : "#991B1B",
          }}
        >
          {notice.kind === "connected"
            ? "Mailbox connected. AB Agent is scanning the last 7 days now; new mail is picked up automatically."
            : ERROR_TEXT[notice.reason ?? ""] ?? "Connecting the mailbox failed. Try again."}
        </div>
      )}

      {/* Email connection */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "6px 0 12px" }}>
        <Mail size={16} color="#3D38FF" />
        <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>Email</h3>
      </div>

      {active.length > 0 ? (
        <Panel style={{ padding: 0, maxWidth: 620, overflow: "hidden", marginBottom: 16 }}>
          {active.map((a, i) => (
            <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderTop: i === 0 ? "none" : "1px solid #EEF1F6" }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 500, color: "#0F172A" }}>{a.externalEmail ?? a.provider}</div>
                <div style={{ fontSize: 12, color: "#94A3B8" }}>
                  {a.provider} · last read {a.lastPolledAt ? new Date(a.lastPolledAt).toLocaleString("en-PH", { timeZone: APP_TIMEZONE }) : "—"}
                </div>
                {a.status === "error" && a.lastError && (
                  <div style={{ fontSize: 12, color: "#DC2626", marginTop: 2 }}>{a.lastError}</div>
                )}
              </div>
              {a.status === "error" ? (
                <>
                  <span style={badge("#DC2626", "#FEE2E2")}>Error</span>
                  {isOwner && CONNECT_URL[a.provider] && (
                    <Button size="sm" variant="outline" asChild>
                      <a href={CONNECT_URL[a.provider]}>Reconnect</a>
                    </Button>
                  )}
                </>
              ) : (
                <>
                  <span style={badge("#16A34A", "#DCFCE7")}>Connected</span>
                  <Button size="sm" variant="outline" onClick={syncNow} disabled={syncing || busy !== null} title="Read new mail now instead of waiting for the next scheduled scan">
                    {syncing ? <Loader2 className="animate-spin" size={13} /> : <RefreshCw size={13} />}
                    Sync now
                  </Button>
                </>
              )}
              {isOwner && (
                <Button size="sm" variant="ghost" onClick={() => disconnect(a.id)} disabled={busy !== null} title="Disconnect">
                  {busy === a.id ? <Loader2 className="animate-spin" size={15} /> : <Unplug size={15} />}
                </Button>
              )}
            </div>
          ))}
          {syncNote && (
            <div style={{ padding: "8px 16px", borderTop: "1px solid #EEF1F6", fontSize: 12, color: syncNote.startsWith("Sync failed") ? "#DC2626" : "#64748B" }}>
              {syncNote}
            </div>
          )}
        </Panel>
      ) : (
        <Panel style={{ padding: 20, maxWidth: 620, marginBottom: 16 }}>
          <div style={{ fontSize: 13, color: "#64748B", marginBottom: 14 }}>
            No mailbox connected yet. Once connected, AB Agent scans the last 7 days, then reads
            each new email as it arrives.
          </div>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            {providers.map((p) => (
              <div key={p.id} style={{ flex: "1 1 220px", border: "1px solid #E2E8F0", borderRadius: 10, padding: 14 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: "#0F172A", marginBottom: 8 }}>{p.label}</div>
                {p.connectable && isOwner && CONNECT_URL[p.id] ? (
                  <Button size="sm" asChild>
                    <a href={CONNECT_URL[p.id]}>Connect</a>
                  </Button>
                ) : (
                  <>
                    <Button size="sm" disabled title={p.connectable ? "Only the owner can connect" : "Coming soon"}>
                      Connect
                    </Button>
                    {!p.connectable && (
                      <span style={{ ...badge("#64748B", "#F1F5F9"), marginLeft: 8 }}>
                        {p.id === "gmail" ? "Not configured" : "On the roadmap"}
                      </span>
                    )}
                  </>
                )}
              </div>
            ))}
          </div>
        </Panel>
      )}

      {!isOwner && <p style={{ ...sub, marginTop: 14 }}>Only the owner can connect a mailbox.</p>}
    </>
  );
}

function badge(color: string, bg: string): React.CSSProperties {
  return { fontSize: 11, fontWeight: 600, color, background: bg, borderRadius: 999, padding: "2px 9px", whiteSpace: "nowrap" };
}

function SaveButton({ pending, ok }: { pending: boolean; ok?: boolean }) {
  return (
    <Button size="sm" disabled={pending}>
      {pending ? <Loader2 className="animate-spin" size={15} /> : ok ? <Check size={15} /> : null}
      {ok ? "Saved" : "Save"}
    </Button>
  );
}

const h2: React.CSSProperties = { fontSize: 22, fontWeight: 700, margin: 0, marginBottom: 6 };
const sub: React.CSSProperties = { fontSize: 13, color: "#64748B", marginTop: 0, marginBottom: 18 };
const label: React.CSSProperties = { display: "block", fontSize: 12, fontWeight: 600, color: "#64748B", margin: "12px 0 6px" };
const input: React.CSSProperties = { width: "100%", padding: "9px 11px", border: "1px solid #E2E8F0", borderRadius: 8, fontSize: 14, color: "#0F172A", boxSizing: "border-box" };
const err: React.CSSProperties = { fontSize: 13, color: "#DC2626", marginTop: 12, marginBottom: 0 };
