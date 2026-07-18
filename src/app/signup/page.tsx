"use client";

import { useActionState } from "react";
import Link from "next/link";
import { signUpAction, type AuthResult } from "@/lib/auth/actions";
import {
  pageStyle,
  cardStyle,
  labelStyle,
  inputStyle,
  errorStyle,
  buttonStyle,
} from "@/app/login/page";

export default function SignupPage() {
  const [state, action, pending] = useActionState<AuthResult, FormData>(signUpAction, {});

  return (
    <div style={pageStyle}>
      <form action={action} style={cardStyle}>
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
        <h1 style={{ fontSize: 20, fontWeight: 600, color: "#0F172A", margin: "8px 0 2px" }}>
          Create your company
        </h1>
        <p style={{ fontSize: 13, color: "#64748B", marginBottom: 6 }}>
          You&apos;ll be the owner and can invite your team afterwards.
        </p>
        <label style={labelStyle}>Company name</label>
        <input name="company" required style={inputStyle} placeholder="Acme Procurement GmbH" />
        <label style={labelStyle}>Your name</label>
        <input name="name" autoComplete="name" style={inputStyle} />
        <label style={labelStyle}>Email</label>
        <input name="email" type="email" required autoComplete="email" style={inputStyle} />
        <label style={labelStyle}>Password</label>
        <input
          name="password"
          type="password"
          required
          autoComplete="new-password"
          minLength={8}
          style={inputStyle}
          placeholder="At least 8 characters"
        />
        {state.error && <p style={errorStyle}>{state.error}</p>}
        <button type="submit" disabled={pending} style={buttonStyle(pending)}>
          {pending ? "Creating…" : "Create account"}
        </button>
        <p style={{ fontSize: 13, color: "#64748B", marginTop: 16, textAlign: "center" }}>
          Already have an account?{" "}
          <Link href="/login" style={{ color: "#3D38FF", fontWeight: 600 }}>
            Sign in
          </Link>
        </p>
      </form>
    </div>
  );
}
