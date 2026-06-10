"use client";

import { useActionState, useState } from "react";
import { createSignal } from "@/app/actions/signals";
import { DAILY_SIGNAL_LIMIT } from "@/lib/constants";

export default function TraderForm({ remaining }: { remaining: number }) {
  const [state, action, pending] = useActionState(createSignal, undefined);
  const [orderType, setOrderType] = useState("market");
  const exhausted = remaining <= 0;
  const used = DAILY_SIGNAL_LIMIT - remaining;

  return (
    <form action={action} className="space-y-5 border border-border bg-surface p-5">
      <div className="flex items-baseline justify-between">
        <h2 className="font-mono text-xs uppercase tracking-wider text-muted">
          post signal
        </h2>
        <span
          className={`font-mono text-xs ${exhausted ? "text-sell" : "text-muted"}`}
        >
          {used} of {DAILY_SIGNAL_LIMIT} used today
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Select name="direction" label="direction" options={["buy", "sell"]} />
        <Select
          name="order_type"
          label="type"
          options={["market", "pending"]}
          value={orderType}
          onChange={setOrderType}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        {orderType === "pending" ? (
          <Field name="entry_price" label="entry" type="number" step="0.01" required />
        ) : (
          <div className="space-y-1">
            <span className="text-xs uppercase tracking-wider text-muted">entry</span>
            <p className="border border-border bg-background px-3 py-2 font-mono text-sm text-muted">
              live price (locked)
            </p>
          </div>
        )}
        <Field name="stop_loss" label="stop loss" type="number" step="0.01" required />
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Field name="tp1" label="tp1" type="number" step="0.01" required />
        <Field name="tp2" label="tp2 (opt)" type="number" step="0.01" />
        <Field name="tp3" label="tp3 (opt)" type="number" step="0.01" />
      </div>

      <Field name="note" label="note" placeholder="optional" />

      {state?.error && (
        <p className="font-mono text-xs text-sell">{state.error}</p>
      )}

      <button
        type="submit"
        disabled={pending || exhausted}
        className="border border-border bg-background px-5 py-2 text-sm hover:border-foreground disabled:cursor-not-allowed disabled:opacity-50"
      >
        {exhausted ? "daily limit reached" : pending ? "posting..." : "post"}
      </button>
      <p className="text-[10px] leading-relaxed text-muted">
        market entry is fixed to the live price server-side. tp1 decides the
        outcome (win); tp2/tp3 are extra targets drawn on the chart. once posted,
        a signal is locked and only the engine can close it.
      </p>
    </form>
  );
}

function Field({
  label,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs uppercase tracking-wider text-muted">{label}</span>
      <input
        {...props}
        className="block w-full border border-border bg-background px-3 py-2 font-mono text-sm focus:border-foreground focus:outline-none"
      />
    </label>
  );
}

function Select({
  name,
  label,
  options,
  value,
  onChange,
}: {
  name: string;
  label: string;
  options: string[];
  value?: string;
  onChange?: (v: string) => void;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-xs uppercase tracking-wider text-muted">{label}</span>
      <select
        name={name}
        defaultValue={value ?? options[0]}
        onChange={onChange ? (e) => onChange(e.target.value) : undefined}
        className="block w-full border border-border bg-background px-3 py-2 font-mono text-sm focus:border-foreground focus:outline-none"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}
