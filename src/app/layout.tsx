import type { Metadata } from "next";
import { DM_Sans, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import AppShell from "@/components/layout/AppShell";
import { getSession } from "@/lib/auth/server";

const dmSans = DM_Sans({
  variable: "--font-dm-sans",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "AB Agent",
  description:
    "Jede Bestellung bekommt ein bestätigtes, korrektes Lieferdatum — ohne dass jemand Dokumente lesen muss.",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const session = await getSession();
  const user = session
    ? {
        name: session.profile.name,
        email: session.email,
        company: session.company.name,
      }
    : undefined;
  return (
    <html lang="de" className={`${dmSans.variable} ${jetbrainsMono.variable}`}>
      <body>
        <AppShell user={user}>{children}</AppShell>
      </body>
    </html>
  );
}
