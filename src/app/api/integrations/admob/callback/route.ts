import { NextResponse, type NextRequest } from "next/server";
import { encryptSecret } from "@/lib/crypto";
import { ADMOB_SCOPES, AdMobError, describeAccessToken, exchangeCode, listPublisherIds, readAdMobEnv, refreshAccessToken } from "@/lib/revenue/admob";
import { createClient } from "@/lib/supabase/server";

/** Failure stage → short code shown on the Revenue page. The log line carries Google's own (secret-free) message. */
const fail = (req: NextRequest, code: string, stage: string, detail?: string) => {
  console.warn(`[admob] connect failed at "${stage}"${detail ? `: ${detail.slice(0, 300)}` : ""}`);
  return back(req, code);
};

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

  const redirectUri = `${request.nextUrl.origin}/api/integrations/admob/callback`;

  // Stage 1: exchange the one-time code for tokens.
  let tokens;
  try {
    tokens = await exchangeCode(cfg.env, q.get("code")!, redirectUri, verifier);
  } catch (e) {
    return fail(request, "exchange", "code exchange", e instanceof Error ? e.message : undefined);
  }
  if (!tokens.refresh_token) return fail(request, "no_refresh", "refresh token missing", "Google returned no refresh_token (the app was probably authorized before; revoke it at myaccount.google.com/permissions and retry)");
  const missing = ADMOB_SCOPES.filter((s) => !(tokens.scope ?? "").split(" ").includes(s));
  if (missing.length) return fail(request, "scope", "granted scopes", `missing ${missing.map((s) => s.split("/").pop()).join(", ")}`);

  // Stage 2: can this Google user reach an AdMob account through the API?
  let publishers: string[];
  let access = "";
  try {
    access = await refreshAccessToken(cfg.env, tokens.refresh_token);
    publishers = await listPublisherIds(access);
  } catch (e) {
    const kind = e instanceof AdMobError ? e.kind : "failed";
    const code = kind === "api_disabled" ? "api_disabled" : kind === "forbidden" ? "forbidden" : kind === "reauthorize" ? "api_unauthorized" : "api_failed";
    // For auth failures, say what Google thinks of the token (secret-free) so the cause can be named.
    const info = access && (kind === "reauthorize" || kind === "forbidden") ? ` | ${await describeAccessToken(access, cfg.env.clientId)}` : "";
    return fail(request, code, "AdMob accounts.list", `${e instanceof Error ? e.message : ""}${info}`);
  }
  if (publishers.length === 0) return fail(request, "account", "AdMob accounts.list", "the Google user has no AdMob account");

  // Stage 3: store ONLY the encrypted refresh token and the publisher id.
  try {
    const { error } = await supabase.from("admob_connection").upsert({
      id: 1, publisher_id: publishers[0], token_ciphertext: encryptSecret(tokens.refresh_token, cfg.env.encryptionKey), scope: tokens.scope,
      connected_by_email: data.user.email ?? null, connected_at: new Date().toISOString(), last_error: null,
    }, { onConflict: "id" });
    if (error) return fail(request, "storage", "database save", error.message);
  } catch (e) {
    return fail(request, "storage", "encryption/database", e instanceof Error ? e.message : undefined);
  }
  return back(request, "connected");
}
