import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { getProfile } from "@/lib/supabase/session";
import Shell from "@/components/Shell";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "halyard — gold signal verifier",
  description: "verified XAU/USD track record",
};

// Resolve the theme (dark default, or the stored preference / OS) and set it on
// <html> synchronously during HTML parsing, before the first paint — so there's
// no flash of the wrong theme. Stays in sync with ThemeToggle (same storage key).
const THEME_SCRIPT = `(function(){try{var p=localStorage.getItem('halyard-theme')||'system';var d=p==='dark'||(p==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.setAttribute('data-theme',d?'dark':'light');}catch(e){}})();`;

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const profile = await getProfile();

  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-screen bg-background text-foreground">
        <Shell profile={profile ? { username: profile.username, role: profile.role } : null}>
          {children}
        </Shell>
      </body>
    </html>
  );
}
