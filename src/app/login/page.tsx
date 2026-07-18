"use client";

import { useActionState, Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { signInAction, type AuthResult } from "@/lib/auth/actions";

function LoginForm() {
  const [state, action, pending] = useActionState<AuthResult, FormData>(signInAction, {});
  const next = useSearchParams().get("next") ?? "/matching";

  return (
    <form action={action} style={cardStyle}>
      <Brand />
      <h1 style={{ fontSize: 20, fontWeight: 600, color: "#0F172A", margin: "8px 0 2px" }}>
        Sign in
      </h1>
      <p style={{ fontSize: 13, color: "#64748B", marginBottom: 18 }}>
        Welcome back.
      </p>
      <input type="hidden" name="next" value={next} />
      <label style={labelStyle}>Email</label>
      <input name="email" type="email" required autoComplete="email" style={inputStyle} />
      <label style={labelStyle}>Password</label>
      <input name="password" type="password" required autoComplete="current-password" style={inputStyle} />
      {state.error && <p style={errorStyle}>{state.error}</p>}
      <button type="submit" disabled={pending} style={buttonStyle(pending)}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
      <p style={{ fontSize: 13, color: "#64748B", marginTop: 16, textAlign: "center" }}>
        No account?{" "}
        <Link href="/signup" style={{ color: "#3D38FF", fontWeight: 600 }}>
          Create one
        </Link>
      </p>
    </form>
  );
}

export default function LoginPage() {
  return (
    <div style={pageStyle}>
      <Suspense>
        <LoginForm />
      </Suspense>
    </div>
  );
}

function Brand() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
      <div
        style={{
          width: 32,
          height: 32,
          borderRadius: "50%",
          background: "#0B1628",
          color: "#fff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontWeight: 700,
        }}
      >
        d
      </div>
      <span style={{ fontWeight: 700, fontSize: 18, color: "#0F172A" }}>AB Agent</span>
    </div>
  );
}

export const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "#F5F5F5",
  padding: 24,
};
export const cardStyle: React.CSSProperties = {
  width: "100%",
  maxWidth: 380,
  background: "#fff",
  border: "1px solid #E2E8F0",
  borderRadius: 12,
  padding: 28,
  boxShadow: "0 4px 20px rgba(15,23,42,0.06)",
};
export const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  fontWeight: 600,
  color: "#64748B",
  margin: "12px 0 6px",
};
export const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  border: "1px solid #E2E8F0",
  borderRadius: 8,
  fontSize: 14,
  color: "#0F172A",
  outline: "none",
  boxSizing: "border-box",
};
export const errorStyle: React.CSSProperties = {
  fontSize: 13,
  color: "#DC2626",
  marginTop: 12,
  marginBottom: 0,
};
export const buttonStyle = (pending: boolean): React.CSSProperties => ({
  width: "100%",
  marginTop: 18,
  padding: "11px 12px",
  background: pending ? "#8b88ff" : "#3D38FF",
  color: "#fff",
  border: "none",
  borderRadius: 8,
  fontSize: 14,
  fontWeight: 600,
  cursor: pending ? "default" : "pointer",
});
