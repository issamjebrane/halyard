"use client";

import { useEffect, useSyncExternalStore } from "react";

// Three-way theme control: light · dark · system. The stored preference (this
// key) is read by the inline script in app/layout.tsx before first paint, so the
// page never flashes the wrong theme. We set `data-theme` to the RESOLVED value
// (always "light" or "dark") on <html>; "system" follows the OS live.
type Pref = "light" | "dark" | "system";
const KEY = "halyard-theme";

const isPref = (v: unknown): v is Pref => v === "light" || v === "dark" || v === "system";

const prefersDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;
const resolve = (p: Pref): "light" | "dark" => (p === "system" ? (prefersDark() ? "dark" : "light") : p);

// Tiny external store over localStorage so the toggle reads the saved preference
// without a hydration mismatch (server snapshot = "system") and without calling
// setState inside an effect. `storage` keeps it in sync across tabs.
const listeners = new Set<() => void>();
function subscribe(cb: () => void) {
  listeners.add(cb);
  window.addEventListener("storage", cb);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", cb);
  };
}
function getSnapshot(): Pref {
  try {
    const s = localStorage.getItem(KEY);
    if (isPref(s)) return s;
  } catch {
    /* localStorage unavailable */
  }
  return "system";
}
function setStored(p: Pref) {
  try {
    localStorage.setItem(KEY, p);
  } catch {
    /* localStorage unavailable */
  }
  listeners.forEach((l) => l());
}

export default function ThemeToggle() {
  const pref = useSyncExternalStore(subscribe, getSnapshot, () => "system" as Pref);

  // while on "system", track OS changes and re-resolve the active theme live.
  useEffect(() => {
    if (pref !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => document.documentElement.setAttribute("data-theme", mq.matches ? "dark" : "light");
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [pref]);

  const choose = (p: Pref) => {
    setStored(p);
    document.documentElement.setAttribute("data-theme", resolve(p));
  };

  const options: { id: Pref; label: string; icon: React.ReactNode }[] = [
    { id: "light", label: "light", icon: <SunIcon /> },
    { id: "dark", label: "dark", icon: <MoonIcon /> },
    { id: "system", label: "system theme", icon: <MonitorIcon /> },
  ];

  return (
    <div role="group" aria-label="color theme" className="flex items-center border border-border">
      {options.map((o) => {
        const on = pref === o.id;
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => choose(o.id)}
            aria-label={o.label}
            aria-pressed={on}
            title={o.label}
            className={`flex h-7 w-7 items-center justify-center transition-colors ${
              on ? "bg-surface text-accent" : "text-muted hover:text-foreground"
            }`}
          >
            {o.icon}
          </button>
        );
      })}
    </div>
  );
}

const svg = {
  width: 14,
  height: 14,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

function SunIcon() {
  return (
    <svg {...svg}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg {...svg}>
      <path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z" />
    </svg>
  );
}

function MonitorIcon() {
  return (
    <svg {...svg}>
      <rect x="3" y="4" width="18" height="12" rx="1" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  );
}
