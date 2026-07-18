// Central env access. Import from here so a missing var fails loudly in one place.
// server-only: these accessors read secrets (service-role key, API key). The
// guard throws at build time if this module is ever pulled into a client bundle.
import "server-only";

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.local.example to .env.local and fill it in.`,
    );
  }
  return v;
}

// Extraction model. This is a code-level choice, not per-environment config or a
// secret — so it lives here, not in .env.local. Change it in one place.
export const ANTHROPIC_MODEL = "claude-opus-4-8";

// Mailbox triage classifier. When the scan loop reads EVERY inbound message we
// can't afford the extraction model (Opus) on newsletters — this cheap, fast
// model answers the single yes/no "is this an order confirmation?" gate before
// anything reaches ANTHROPIC_MODEL. Also a code-level choice.
export const CLASSIFIER_MODEL = "claude-haiku-4-5-20251001";

export const config = {
  anthropic: {
    apiKey: () => required("ANTHROPIC_API_KEY"),
    model: () => ANTHROPIC_MODEL,
    classifierModel: () => CLASSIFIER_MODEL,
  },
  supabase: {
    url: () => required("NEXT_PUBLIC_SUPABASE_URL"),
    serviceRoleKey: () => required("SUPABASE_SERVICE_ROLE_KEY"),
    bucket: () => process.env.SUPABASE_STORAGE_BUCKET || "ab-documents",
  },
  // Google OAuth client for the Gmail mailbox integration (Settings →
  // Integrations → Connect). Created in Google Cloud Console; both unset simply
  // means Gmail shows as not connectable — nothing fails.
  google: {
    clientId: () => required("GOOGLE_CLIENT_ID"),
    clientSecret: () => required("GOOGLE_CLIENT_SECRET"),
    isConfigured: () =>
      !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET,
  },
  // Canonical external URL for OAuth redirects. Unset → derived per-request from
  // forwarded headers (works on Vercel and localhost); set it only if the app
  // sits behind a proxy that doesn't forward host/proto.
  appUrl: () => process.env.APP_URL || "",
  inboundSecret: () => process.env.INBOUND_WEBHOOK_SECRET || "",
  // Guards the mailbox poll cron (/api/mail/poll), same fail-closed posture as
  // the inbound webhook: no secret set → the endpoint refuses to run.
  mailPollSecret: () => process.env.MAIL_POLL_SECRET || "",
  seedToken: () => process.env.SEED_TOKEN || "",
  // Read-only intake address shown in the UI (where suppliers forward ABs).
  intakeEmail: () => process.env.INTAKE_EMAIL || "ab-intake@example.com",
  // True once the minimum secrets are present. Pages use this to show a setup
  // notice instead of throwing before the environment is wired up.
  isConfigured: () =>
    !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
    !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!process.env.ANTHROPIC_API_KEY,
};

// Upload guardrails.
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB per file
