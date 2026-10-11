import { NextResponse, type NextRequest } from "next/server";
import { encryptSecret } from "@/lib/crypto";
import { ADMOB_SCOPES, exchangeCode, listPublisherIds, readAdMobEnv, refreshAccessToken } from "@/lib/revenue/admob";
import { createClient } from "@/lib/supabase/server";

const back = (req: NextRequest, code: string) => {
  const res = NextResponse.redirect(new URL(`/revenue?admob=${code}`, req.url));
  res.cookies.set("admob_oauth", "", { path: "/api/integrations/admob", maxAge: 0 });
  return res;
};

/** OAuth callback: verifies state, exchanges the code, stores ONLY the refresh token (encrypted) and the publisher id. */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return NextResponse.redirect(new URL("/login", request.url));
  const cfg = readAdMobEnv();
  if (!cfg.ok) return back(request, "config");

  const q = request.nextUrl.searchParams;
  if (q.get("error")) return back(request, "denied");
  const [state, verifier] = (request.cookies.get("admob_oauth")?.value ?? "").split(".");
  if (!state || !verifier || q.get("state") !== state || !q.get("code")) return back(request, "state");

  try {
    const redirectUri = `${request.nextUrl.origin}/api/integrations/admob/callback`;
    const tokens = await exchangeCode(cfg.env, q.get("code")!, redirectUri, verifier);
    if (!tokens.refresh_token) return back(request, "token");
    if (!ADMOB_SCOPES.every((s) => (tokens.scope ?? "").split(" ").includes(s))) return back(request, "scope");
    const publishers = await listPublisherIds(await refreshAccessToken(cfg.env, tokens.refresh_token));
    if (publishers.length === 0) return back(request, "account");

    const { error } = await supabase.from("admob_connection").upsert({
      id: 1, publisher_id: publishers[0], token_ciphertext: encryptSecret(tokens.refresh_token, cfg.env.encryptionKey), scope: tokens.scope,
      connected_by_email: data.user.email ?? null, connected_at: new Date().toISOString(), last_error: null,
    }, { onConflict: "id" });
    return back(request, error ? "token" : "connected");
  } catch {
    return back(request, "token");
  }
}
