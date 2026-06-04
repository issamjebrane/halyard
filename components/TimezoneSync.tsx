"use client";

import { useEffect, useRef } from "react";
import { syncTimezone } from "@/app/actions/profile";

// Detects the browser timezone once and reports it to the server, so the daily
// cap resets at the trader's local midnight. Renders nothing.
export default function TimezoneSync({ current }: { current: string }) {
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz && tz !== current) syncTimezone(tz);
    } catch {
      // Intl unavailable — server keeps the stored/UTC value.
    }
  }, [current]);
  return null;
}
