import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "./supabase/server";

/** Browsers always send Origin on cross-site POSTs; require it to match our host. */
export function isSameOrigin(origin: string | null, host: string | null): boolean {
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * Guard for JSON route handlers: same-origin + JSON body + valid Supabase session.
 * Returns the user-scoped client (RLS applies) or a ready-made error response.
 */
export async function apiGuard(request: NextRequest) {
  if (!isSameOrigin(request.headers.get("origin"), request.headers.get("host"))) {
    return { error: NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 }) } as const;
  }
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return { error: NextResponse.json({ ok: false, error: "Expected JSON" }, { status: 415 }) } as const;
  }
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return { error: NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 }) } as const;
  return { supabase } as const;
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : "Unexpected error");
