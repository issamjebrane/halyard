"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "@/app/actions/auth";
import type { Role } from "@/lib/types";
import ThemeToggle from "./ThemeToggle";

// App chrome (header + main). The admin areas get a wider column for the
// dashboard's grids and the 15-column signals table; everything else stays at
// the narrow editorial width. Done here (client) so width can key off the route
// without touching every page.
export default function Shell({
  profile,
  children,
}: {
  profile: { username: string; role: Role } | null;
  children: React.ReactNode;
}) {
  const path = usePathname();
  const wide = path === "/admin" || path.startsWith("/audit");
  const width = wide ? "max-w-6xl" : "max-w-3xl";

  return (
    <>
      <header className="border-b border-border">
        <div className={`mx-auto flex ${width} flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-4 sm:px-6`}>
          <Link href="/" className="font-mono text-sm tracking-wide">
            halyard
          </Link>
          <nav className="flex w-full flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted sm:w-auto sm:justify-end sm:gap-5">
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
            <ThemeToggle />
          </nav>
        </div>
      </header>
      <main className={`mx-auto ${width} px-4 py-10 sm:px-6`}>{children}</main>
    </>
  );
}
