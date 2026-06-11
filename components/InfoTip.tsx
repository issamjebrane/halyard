// Reusable "i" info icon. On hover (or keyboard focus) it shows the passed
// explanation. Pure CSS — safe inside a server component and inside an <h2>
// (renders only <span>s, which are valid phrasing content).

export default function InfoTip({
  children,
  label = "More info",
  width = "w-72",
  align = "left",
}: {
  children: React.ReactNode;
  label?: string;
  width?: string;
  align?: "left" | "right";
}) {
  return (
    <span className="group relative inline-flex align-middle normal-case tracking-normal">
      <span
        tabIndex={0}
        role="img"
        aria-label={label}
        data-tip
        className="flex h-4 w-4 cursor-help select-none items-center justify-center rounded-full border border-border text-[10px] font-medium leading-none text-muted hover:border-foreground hover:text-foreground focus:text-foreground focus:outline-none"
      >
        i
      </span>
      <span
        role="tooltip"
        className={`pointer-events-none absolute ${
          align === "right" ? "right-0" : "left-0"
        } top-6 z-30 hidden ${width} max-w-[80vw] border border-border bg-background p-3 text-left text-[11px] font-normal leading-relaxed text-muted shadow-lg group-hover:block group-focus-within:block`}
      >
        {children}
      </span>
    </span>
  );
}
