"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export async function signIn(_prev: { error: string | null }, form: FormData): Promise<{ error: string | null }> {
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");
  if (!email || !password) return { error: "Enter your email and password." };
  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { error: "Invalid email or password." };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Sign-in failed." };
  }
  redirect("/");
}
