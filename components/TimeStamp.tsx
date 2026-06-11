"use client";

import { rel } from "@/lib/format";

// Exact local time of an operation (with seconds). Hover shows the full date,
// timezone, and the relative age. Renders in the viewer's local timezone.
export default function TimeStamp({
  iso,
  className = "",
}: {
  iso: string | null | undefined;
  className?: string;
}) {
  if (!iso) return <span className={className}>—</span>;
  const d = new Date(iso);
  const exact = d.toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const full = d.toLocaleString(undefined, {
    dateStyle: "full",
    timeStyle: "long",
  });
  return (
    <time
      dateTime={iso}
      title={`${full} · ${rel(iso)} ago`}
      className={className}
      suppressHydrationWarning
    >
      {exact}
    </time>
  );
}
