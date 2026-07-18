"use client";

import { useActionState } from "react";
import { Loader2, Trash2, Star } from "lucide-react";
import { Panel } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import {
  addContactAction,
  deleteContactAction,
  setDefaultContactAction,
  type ActionResult,
} from "@/lib/auth/settings-actions";

export interface ContactRow {
  id: string;
  supplier: string;
  name: string | null;
  email: string;
  isDefault: boolean;
  source: string; // 'inbound' (from their email) | 'outbound' (you wrote them) | 'manual'
}

// Human labels for how a contact entered the book.
const CONTACT_SOURCE: Record<string, string> = {
  inbound: "from their email",
  outbound: "you wrote them",
  manual: "added by hand",
};

export default function ContactsClient({ contacts }: { contacts: ContactRow[] }) {
  const [addState, addAction, adding] = useActionState<ActionResult, FormData>(addContactAction, {});
  const [, deleteAction] = useActionState<ActionResult, FormData>(deleteContactAction, {});
  const [, defaultAction] = useActionState<ActionResult, FormData>(setDefaultContactAction, {});

  return (
    <div style={{ padding: 32, maxWidth: 1080 }}>
      <h2 style={h2}>Supplier contacts</h2>
      <p style={sub}>
        Who to email at each supplier. AB Agent learns these by itself — the sender of every incoming
        confirmation and every address you send a chaser or pushback to is saved here. The default
        (starred) address prefills the To: field of reminders.
      </p>

      {/* Add a contact — one row across the full width */}
      <Panel style={{ padding: 20, marginBottom: 18 }}>
        <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0, marginBottom: 4 }}>Add a contact</h3>
        <form action={addAction}>
          <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
            <div style={{ flex: "1.2 1 220px" }}>
              <label style={label}>Supplier</label>
              <input name="supplier" required style={input} placeholder="Gusswerk Hartmann GmbH" />
            </div>
            <div style={{ flex: "1 1 180px" }}>
              <label style={label}>Contact person (optional)</label>
              <input name="name" style={input} />
            </div>
            <div style={{ flex: "1.2 1 220px" }}>
              <label style={label}>Email</label>
              <input name="email" type="email" required style={input} placeholder="orders@supplier.de" />
            </div>
            <Button size="sm" disabled={adding} style={{ height: 38 }}>
              {adding ? <Loader2 className="animate-spin" size={15} /> : null} Add contact
            </Button>
          </div>
          {addState.error && <p style={err}>{addState.error}</p>}
        </form>
      </Panel>

      {/* All contacts */}
      <Panel style={{ padding: 0, overflow: "hidden" }}>
        {contacts.length === 0 ? (
          <div style={{ padding: 20, fontSize: 13.5, color: "#64748B" }}>
            No contacts yet. They appear automatically once confirmations arrive by email — or add one above.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#94A3B8", fontSize: 12, borderBottom: "1px solid #E2E8F0" }}>
                <th style={{ ...th, width: 44 }} title="Default contact — prefills the To: field of reminders" />
                <th style={th}>Supplier</th>
                <th style={th}>Contact person</th>
                <th style={th}>Email</th>
                <th style={th}>Source</th>
                <th style={{ ...th, width: 44 }} />
              </tr>
            </thead>
            <tbody>
              {contacts.map((c, i) => (
                <tr key={c.id} style={{ borderTop: i === 0 ? "none" : "1px solid #EEF1F6" }}>
                  <td style={{ ...td, paddingLeft: 16 }}>
                    <form action={defaultAction} style={{ display: "flex" }}>
                      <input type="hidden" name="id" value={c.id} />
                      <button
                        type="submit"
                        title={c.isDefault ? "Default contact" : "Make default"}
                        disabled={c.isDefault}
                        style={{ border: "none", background: "transparent", cursor: c.isDefault ? "default" : "pointer", display: "flex", color: c.isDefault ? "#F59E0B" : "#CBD5E1", padding: 0 }}
                      >
                        <Star size={15} fill={c.isDefault ? "#F59E0B" : "none"} />
                      </button>
                    </form>
                  </td>
                  <td style={{ ...td, fontWeight: 600, color: "#0F172A" }}>{c.supplier}</td>
                  <td style={{ ...td, color: c.name ? "#0F172A" : "#CBD5E1" }}>{c.name ?? "—"}</td>
                  <td style={{ ...td, color: "#0F172A" }}>{c.email}</td>
                  <td style={{ ...td, color: "#94A3B8", fontSize: 12.5 }}>{CONTACT_SOURCE[c.source] ?? c.source}</td>
                  <td style={{ ...td, paddingRight: 16 }}>
                    <form action={deleteAction} style={{ display: "flex", justifyContent: "flex-end" }}>
                      <input type="hidden" name="id" value={c.id} />
                      <button type="submit" title="Remove" style={{ border: "none", background: "transparent", cursor: "pointer", color: "#DC2626", display: "flex", padding: 0 }}>
                        <Trash2 size={15} />
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}

const h2: React.CSSProperties = { fontSize: 22, fontWeight: 700, margin: 0, marginBottom: 6 };
const sub: React.CSSProperties = { fontSize: 13, color: "#64748B", marginTop: 0, marginBottom: 18, maxWidth: 720 };
const label: React.CSSProperties = { display: "block", fontSize: 12, fontWeight: 600, color: "#64748B", margin: "12px 0 6px" };
const input: React.CSSProperties = { width: "100%", padding: "9px 11px", border: "1px solid #E2E8F0", borderRadius: 8, fontSize: 14, color: "#0F172A", boxSizing: "border-box", height: 38 };
const err: React.CSSProperties = { fontSize: 13, color: "#DC2626", marginTop: 12, marginBottom: 0 };
const th: React.CSSProperties = { padding: "10px 8px", fontWeight: 600 };
const td: React.CSSProperties = { padding: "9px 8px", verticalAlign: "middle" };
