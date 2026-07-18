import { Panel } from "@/components/ui/panel";

// Shown when the environment isn't wired up yet, so pages don't crash on a
// missing Supabase/Anthropic secret before first run.
export default function SetupNotice() {
  return (
    <div style={{ padding: 32, maxWidth: 720 }}>
      <Panel style={{ padding: 24 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Einrichtung erforderlich</h2>
        <p style={{ color: "#64748B", marginTop: 8, fontSize: 14, lineHeight: 1.6 }}>
          Die Umgebungsvariablen sind noch nicht gesetzt. Kopiere{" "}
          <code>.env.local.example</code> nach <code>.env.local</code> und trage
          folgende Werte ein:
        </p>
        <ul style={{ color: "#0F172A", fontSize: 13, marginTop: 12, lineHeight: 1.9 }}>
          <li><code>ANTHROPIC_API_KEY</code></li>
          <li><code>NEXT_PUBLIC_SUPABASE_URL</code></li>
          <li><code>SUPABASE_SERVICE_ROLE_KEY</code></li>
        </ul>
        <p style={{ color: "#64748B", marginTop: 12, fontSize: 14, lineHeight: 1.6 }}>
          Danach in Supabase das Schema aus{" "}
          <code>supabase/migrations/0001_init.sql</code> anwenden und den Seed
          starten (<code>npm run seed</code>).
        </p>
      </Panel>
    </div>
  );
}
