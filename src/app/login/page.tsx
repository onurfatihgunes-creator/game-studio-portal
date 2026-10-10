import type { Metadata } from "next";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4">
      <h1 className="mb-1 text-xl font-semibold tracking-tight">Game Studio Portal</h1>
      <p className="mb-6 text-sm text-muted">Sign in with an account created in your Supabase project.</p>
      <LoginForm />
    </main>
  );
}
