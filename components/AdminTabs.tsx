"use client";

import { useEffect, useRef, useState } from "react";

// Tabbed shell for the admin dashboard. Purely presentational + tab state — it
// does NO data fetching and touches NO Supabase. The server page renders every
// section to React nodes and hands them in as named slots (the Next.js RSC
// "interleaving" pattern: server components passed as props to a client island).
//
// IMPORTANT — panels are toggled with CSS `display:none`, never unmounted and
// never wrapped in React <Activity>. display:none keeps each panel mounted
// WITHOUT running effect cleanup, so EngineCard's realtime channel and
// SignalsExplorer's filter state survive a tab switch. <Activity mode="hidden">
// would run cleanup and silently tear down the engine heartbeats — do not use it
// here, and do not convert these panels to conditional rendering.

const TABS = [
  { id: "overview", label: "overview" },
  { id: "engines", label: "engines" },
  { id: "curves", label: "curves" },
  { id: "analysis", label: "analysis" },
  { id: "ops", label: "ops" },
  { id: "ledger", label: "ledger" },
] as const;

type TabId = (typeof TABS)[number]["id"];

const isTabId = (s: string): s is TabId => TABS.some((t) => t.id === s);

export default function AdminTabs(slots: Record<TabId, React.ReactNode>) {
  const [active, setActive] = useState<TabId>("overview");
  const rootRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Partial<Record<TabId, HTMLButtonElement | null>>>({});

  // Deep-link support: /admin#engines selects that tab. Read the hash AFTER
  // mount (never in the useState initializer) so server and first client render
  // agree — the server has no hash, so initial render is always "overview".
  useEffect(() => {
    const apply = () => {
      const h = window.location.hash.slice(1);
      if (isTabId(h)) setActive(h);
    };
    apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, []);

  // Single funnel for every activation (click, arrow key, deep link). Uses
  // replaceState (not pushState) so tab taps don't pile up in back-button
  // history — pressing back should leave /admin, not walk back through tabs.
  const go = (id: TabId) => {
    setActive(id);
    history.replaceState(null, "", `#${id}`);
    // Land at the top of the new tab instead of mid-table. Instant (not smooth)
    // so it never animates against a concurrent LiveData router.refresh().
    rootRef.current?.scrollIntoView({ block: "start", behavior: "auto" });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const i = TABS.findIndex((t) => t.id === active);
    let next = i;
    if (e.key === "ArrowRight") next = (i + 1) % TABS.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TABS.length - 1;
    else return;
    e.preventDefault();
    const id = TABS[next].id;
    go(id);
    tabRefs.current[id]?.focus();
  };

  return (
    <div ref={rootRef}>
      <div
        role="tablist"
        aria-label="dashboard sections"
        onKeyDown={onKeyDown}
        className="no-scrollbar sticky top-0 z-20 -mx-6 mb-6 flex gap-5 overflow-x-auto border-b border-border bg-background px-6 py-3 sm:gap-6"
      >
        {TABS.map((t) => {
          const on = active === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`tab-${t.id}`}
              ref={(el) => {
                tabRefs.current[t.id] = el;
              }}
              aria-selected={on}
              aria-controls={`panel-${t.id}`}
              tabIndex={on ? 0 : -1}
              onClick={() => go(t.id)}
              className={`whitespace-nowrap border-b-2 pb-0.5 font-mono text-xs lowercase tracking-wide transition-colors ${
                on
                  ? "border-accent text-foreground"
                  : "border-transparent text-muted hover:text-foreground"
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {TABS.map((t) => {
        const on = active === t.id;
        return (
          <div
            key={t.id}
            role="tabpanel"
            id={`panel-${t.id}`}
            aria-labelledby={`tab-${t.id}`}
            hidden={!on}
            tabIndex={on ? 0 : -1}
            className="space-y-6 focus:outline-none"
          >
            {slots[t.id]}
          </div>
        );
      })}
    </div>
  );
}
