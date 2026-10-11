import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { type AdsConfig, normalizeConfig, testDefaults, validateConfig } from "./config";

type Db = SupabaseClient;
export type AdsRow = AdsConfig & { game_id: string; updated_at: string; updated_by_email: string | null };

export async function getAdsConfig(db: Db, gameId: string): Promise<AdsRow | null> {
  const { data, error } = await db.from("game_ads_config").select("*").eq("game_id", gameId).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as AdsRow | null) ?? null;
}

export async function listAdsConfigs(db: Db): Promise<AdsRow[]> {
  const { data, error } = await db.from("game_ads_config").select("*");
  if (error) throw new Error(error.message);
  return (data ?? []) as AdsRow[];
}

/** Server-side validation is authoritative: the browser's checks are only a convenience. */
export async function saveAdsConfig(db: Db, gameId: string, input: Partial<AdsConfig>, email: string | null): Promise<{ problems: ReturnType<typeof validateConfig> }> {
  const cfg = normalizeConfig(input);
  const problems = validateConfig(cfg);
  const errors = problems.filter((p) => p.level === "error");
  if (errors.length) throw new Error(errors.map((e) => e.message).join(" "));
  const { error } = await db.from("game_ads_config").upsert({ game_id: gameId, ...cfg, updated_at: new Date().toISOString(), updated_by_email: email }, { onConflict: "game_id" });
  if (error) throw new Error(error.message);
  return { problems };
}

/** Batch: give every listed game WITHOUT a config the safe test defaults (disabled, test mode, Google demo IDs). Never overwrites. */
export async function applyTestDefaults(db: Db, gameIds: string[], email: string | null): Promise<number> {
  if (gameIds.length === 0) return 0;
  const { data: have, error } = await db.from("game_ads_config").select("game_id").in("game_id", gameIds);
  if (error) throw new Error(error.message);
  const existing = new Set((have ?? []).map((r) => r.game_id as string));
  const rows = gameIds.filter((id) => !existing.has(id)).map((id) => ({ game_id: id, ...testDefaults(), updated_at: new Date().toISOString(), updated_by_email: email }));
  if (rows.length === 0) return 0;
  const { error: insErr } = await db.from("game_ads_config").insert(rows);
  if (insErr) throw new Error(insErr.message);
  return rows.length;
}
