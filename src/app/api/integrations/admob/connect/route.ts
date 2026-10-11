import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { buildAuthUrl, pkcePair, readAdMobEnv } from "@/lib/revenue/admob";
import { createClient } from "@/lib/supabase/server";

/** Starts the Google OAuth flow (authorization code + PKCE). Only a signed-in portal user can start it. */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return NextResponse.redirect(new URL("/login", request.url));
  const cfg = readAdMobEnv();
  if (!cfg.ok) return NextResponse.redirect(new URL("/revenue?admob=config", request.url));

  const state = randomBytes(24).toString("base64url");
  const { verifier, challenge } = pkcePair();
  const redirectUri = `${request.nextUrl.origin}/api/integrations/admob/callback`;
  const res = NextResponse.redirect(buildAuthUrl({ clientId: cfg.env.clientId, redirectUri, state, challenge }));
  res.cookies.set("admob_oauth", `${state}.${verifier}`, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/api/integrations/admob", maxAge: 600 });
  return res;
}
