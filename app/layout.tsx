import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { getProfile } from "@/lib/supabase/session";
import { signOut } from "@/app/actions/auth";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "halyard — gold signal verifier",
  description: "verified XAU/USD track record",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const profile = await getProfile();

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} antialiased`}
    >
      <body className="min-h-screen bg-background text-foreground">
        <header className="border-b border-border">
          <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
            <Link href="/" className="font-mono text-sm tracking-wide">
              halyard
            </Link>
            <nav className="flex items-center gap-5 text-sm text-muted">
              {profile ? (
                <>
                  {profile.role === "admin" ? (
                    <>
                      <Link href="/admin" className="hover:text-foreground">
                        dashboard
                      </Link>
                      <Link href="/audit" className="hover:text-foreground">
                        audit
                      </Link>
                    </>
                  ) : (
                    <Link href="/trader" className="hover:text-foreground">
                      panel
                    </Link>
                  )}
                  <span className="font-mono text-xs text-muted">
                    {profile.username}
                    <span className="ml-1 text-accent">[{profile.role}]</span>
                  </span>
                  <form action={signOut}>
                    <button type="submit" className="hover:text-foreground">
                      leave
                    </button>
                  </form>
                </>
              ) : (
                <Link href="/login" className="hover:text-foreground">
                  enter
                </Link>
              )}
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-3xl px-6 py-10">{children}</main>
      </body>
    </html>
  );
}
