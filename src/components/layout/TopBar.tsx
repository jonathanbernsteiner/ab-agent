"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Settings as SettingsIcon, LogOut, ChevronDown } from "lucide-react";
import { navItems } from "@/lib/navigation";
import { signOutAction } from "@/lib/auth/actions";

interface UserInfo {
  name: string | null;
  email: string | null;
  company: string | null;
}

// Fixed 56px top bar: page title on the left, user menu on the right.
export default function TopBar({ user }: { user?: UserInfo }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const pageTitle =
    navItems.find((n) => pathname === n.path || pathname?.startsWith(n.path + "/"))?.label ??
    "AB Agent";

  const displayName = user?.name || user?.email || "";
  const initial = (user?.name || user?.email || "?").trim().charAt(0).toUpperCase();

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  return (
    <header
      style={{
        position: "fixed",
        top: 0,
        left: 56,
        right: 0,
        height: 56,
        zIndex: 50,
        backgroundColor: "#FFFFFF",
        borderBottom: "1px solid #E2E8F0",
        display: "flex",
        alignItems: "center",
        padding: "0 24px",
      }}
    >
      <h1 style={{ fontSize: 18, fontWeight: 600, color: "#0F172A", margin: 0, whiteSpace: "nowrap" }}>
        {pageTitle}
      </h1>

      {displayName && (
        <div ref={menuRef} style={{ marginLeft: "auto", position: "relative" }}>
          <button
            onClick={() => setOpen((v) => !v)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              background: "transparent",
              border: "none",
              cursor: "pointer",
              padding: "6px 8px",
              borderRadius: 8,
            }}
          >
            <div style={{ textAlign: "right", lineHeight: 1.2 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#0F172A" }}>{displayName}</div>
              {user?.company && (
                <div style={{ fontSize: 11, color: "#94A3B8" }}>{user.company}</div>
              )}
            </div>
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: "50%",
                backgroundColor: "#3D38FF",
                color: "#FFFFFF",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              {initial}
            </div>
            <ChevronDown size={14} style={{ color: "#94A3B8" }} />
          </button>

          {open && (
            <div
              style={{
                position: "absolute",
                right: 0,
                top: "calc(100% + 6px)",
                minWidth: 200,
                background: "#FFFFFF",
                border: "1px solid #E2E8F0",
                borderRadius: 10,
                boxShadow: "0 8px 24px rgba(15,23,42,0.12)",
                padding: 6,
                zIndex: 60,
              }}
            >
              <div style={{ padding: "8px 10px", borderBottom: "1px solid #EEF1F6", marginBottom: 4 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#0F172A" }}>{displayName}</div>
                <div style={{ fontSize: 12, color: "#94A3B8" }}>{user?.email}</div>
              </div>
              <Link href="/settings" onClick={() => setOpen(false)} style={menuItemStyle}>
                <SettingsIcon size={15} /> Settings
              </Link>
              <form action={signOutAction}>
                <button
                  type="submit"
                  style={{ ...menuItemStyle, width: "100%", border: "none", background: "transparent", cursor: "pointer" }}
                >
                  <LogOut size={15} /> Log out
                </button>
              </form>
            </div>
          )}
        </div>
      )}
    </header>
  );
}

const menuItemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "8px 10px",
  fontSize: 13,
  color: "#0F172A",
  borderRadius: 6,
  textDecoration: "none",
};
