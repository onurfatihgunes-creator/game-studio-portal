import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptSecret } from "../crypto";
import { listAdsConfigs } from "../ads/store";
import { AdMobError, type AdMobEnv, fetchNetworkReport, lastDays, mapRowsToGames, refreshAccessToken } from "./admob";

type Db = SupabaseClient;
export type SyncResult = { days: number; rows: number; gamesWithData: number; unmatched: { appId: string; appName: string | null }[]; truncated: boolean; currency: string | null };

/**
 * Pull the last `days` days of AdMob network reports into revenue_daily. Revenue is stored per game per day;
 * only apps whose production AdMob app ID is configured on a game are attributed. Failures are recorded on the
 * connection and rethrown; existing data is never deleted or modified on failure.
 */
export async function syncAdMob(db: Db, env: AdMobEnv, days = 30): Promise<SyncResult> {
  const { data: conn, error } = await db.from("admob_connection").select("*").eq("id", 1).maybeSingle();
  if (error) throw new Error(error.message);
  if (!conn) throw new Error("AdMob is not connected.");
  const fail = async (message: string) => { await db.from("admob_connection").update({ last_error: message.slice(0, 500) }).eq("id", 1); };

  try {
    const refresh = decryptSecret(conn.token_ciphertext as string, env.encryptionKey);
    const access = await refreshAccessToken(env, refresh);
    const report = await fetchNetworkReport(access, conn.publisher_id as string, lastDays(Math.min(Math.max(days, 1), 90)));
    const configs = await listAdsConfigs(db);
    const games = configs.map((c) => ({ gameId: c.game_id, appIds: [c.android?.app_id, c.ios?.app_id].filter((x): x is string => !!x) }));
    const currency = report.currency ?? "USD";
    const { daily, unmatched } = mapRowsToGames(report.rows, games, currency);
    if (daily.length) {
      const { error: upErr } = await db.from("revenue_daily").upsert(daily.map((d) => ({ ...d, synced_at: new Date().toISOString() })), { onConflict: "game_id,day" });
      if (upErr) throw new Error(upErr.message);
    }
    await db.from("admob_connection").update({ last_synced_at: new Date().toISOString(), last_error: null }).eq("id", 1);
    return { days, rows: report.rows.length, gamesWithData: new Set(daily.map((d) => d.game_id)).size, unmatched, truncated: report.truncated, currency: report.currency };
  } catch (e) {
    const message = e instanceof AdMobError && e.kind === "reauthorize" ? "Google rejected the stored authorization. Disconnect and connect AdMob again." : e instanceof Error ? e.message : "Sync failed";
    await fail(message);
    throw new Error(message);
  }
}
