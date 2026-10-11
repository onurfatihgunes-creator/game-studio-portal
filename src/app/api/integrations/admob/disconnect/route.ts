import { NextResponse, type NextRequest } from "next/server";
import { apiGuard, errorMessage } from "@/lib/api";
import { decryptSecret } from "@/lib/crypto";
import { readAdMobEnv, revokeToken } from "@/lib/revenue/admob";

/** Disconnect AdMob: revokes the token at Google (best effort) and deletes the stored connection. Stored revenue history is kept. */
export async function POST(request: NextRequest) {
  const g = await apiGuard(request);
  if ("error" in g) return g.error;
  try {
    const cfg = readAdMobEnv();
    const { data: conn } = await g.supabase.from("admob_connection").select("token_ciphertext").eq("id", 1).maybeSingle();
    if (conn && cfg.ok) { try { await revokeToken(decryptSecret(conn.token_ciphertext as string, cfg.env.encryptionKey)); } catch { /* still delete locally */ } }
    const { error } = await g.supabase.from("admob_connection").delete().eq("id", 1);
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: errorMessage(e) }, { status: 400 });
  }
}
