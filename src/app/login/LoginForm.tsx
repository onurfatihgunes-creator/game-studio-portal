"use client";

import { useActionState } from "react";
import { signIn } from "./actions";

export function LoginForm() {
  const [state, action, pending] = useActionState(signIn, { error: null });
  return (
    <form action={action} className="card flex flex-col gap-3 p-5">
      <label className="text-sm font-medium">
        Email
        <input name="email" type="email" autoComplete="email" required className="input mt-1" />
      </label>
      <label className="text-sm font-medium">
        Password
        <input name="password" type="password" autoComplete="current-password" required className="input mt-1" />
      </label>
      {state.error && <p role="alert" className="text-sm text-[var(--bad-fg)]">{state.error}</p>}
      <button className="btn btn-primary" disabled={pending}>{pending ? "Signing in…" : "Sign in"}</button>
    </form>
  );
}
