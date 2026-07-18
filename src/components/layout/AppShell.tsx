"use client";

import { usePathname } from "next/navigation";
import Sidebar from "./Sidebar";
import TopBar from "./TopBar";

// Auth screens render bare (no sidebar/topbar).
const BARE_PREFIXES = ["/login", "/signup"];

// Wraps every page: fixed 56px icon rail on the left, fixed 56px top bar,
// content offset to clear both. Imported once in app/layout.tsx.
export default function AppShell({
  children,
  user,
}: {
  children: React.ReactNode;
  user?: { name: string | null; email: string | null; company: string | null };
}) {
  const pathname = usePathname();
  if (BARE_PREFIXES.some((p) => pathname === p || pathname?.startsWith(p + "/"))) {
    return <>{children}</>;
  }
  return (
    <>
      <Sidebar />
      <TopBar user={user} />
      <main style={{ marginLeft: 56, paddingTop: 56 }} className="min-h-screen">
        {children}
      </main>
    </>
  );
}
