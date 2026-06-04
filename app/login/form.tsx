"use client";

import { useActionState } from "react";
import { signIn } from "@/app/actions/auth";

export default function LoginForm() {
  const [state, action, pending] = useActionState(signIn, undefined);

  return (
    <form action={action} className="max-w-sm space-y-5">
      <h1 className="font-mono text-xs uppercase tracking-wider text-muted">
        enter
      </h1>

      <Field
        name="email"
        type="email"
        label="email"
        required
        autoComplete="email"
      />
      <Field
        name="password"
        type="password"
        label="passphrase"
        required
        autoComplete="current-password"
      />

      {state?.error && (
        <p className="font-mono text-xs text-sell">{state.error}</p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="w-full border border-border bg-surface px-4 py-2 text-sm hover:border-foreground disabled:opacity-50"
      >
        {pending ? "..." : "raise"}
      </button>
    </form>
  );
}

function Field({
  label,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs uppercase tracking-wider text-muted">
        {label}
      </span>
      <input
        {...props}
        className="block w-full border border-border bg-background px-3 py-2 font-mono text-sm focus:border-foreground focus:outline-none"
      />
    </label>
  );
}
