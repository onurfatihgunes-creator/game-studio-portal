import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { type AdsConfig, normalizeConfig, validateConfig } from "./config";
import { findIdConflicts, parseIdImport, planImport, type PlanItem } from "./integration";

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
  const clashes = await idConflictsFor(db, gameId, cfg);
  if (clashes.length) throw new Error(`${clashes[0].id} (${clashes[0].where}) already belongs to ${clashes[0].otherName}. Each game needs its own AdMob app and ad units.`);
  const { error } = await db.from("game_ads_config").upsert({ game_id: gameId, ...cfg, updated_at: new Date().toISOString(), updated_by_email: email }, { onConflict: "game_id" });
  if (error) throw new Error(error.message);
  return { problems };
}

const namesOf = async (db: Db) => {
  const { data, error } = await db.from("games").select("id, name, full_name, repo");
  if (error) throw new Error(error.message);
  return (data ?? []) as { id: string; name: string; full_name: string; repo: string }[];
};

/** Server-side guard behind "never reuse one game's IDs for another". Demo IDs are exempt. */
export async function idConflictsFor(db: Db, gameId: string, cfg: AdsConfig) {
  const [rows, games] = await Promise.all([listAdsConfigs(db), namesOf(db)]);
  const name = new Map(games.map((g) => [g.id, g.name]));
  return findIdConflicts(gameId, cfg, rows.filter((r) => r.game_id !== gameId).map((r) => ({ gameId: r.game_id, name: name.get(r.game_id) ?? "another game", cfg: normalizeConfig(r) })));
}

export async function previewIdImport(db: Db, text: string): Promise<{ plan: PlanItem[]; errors: string[] }> {
  const { rows, errors } = parseIdImport(text);
  const [cfgs, games] = await Promise.all([listAdsConfigs(db), namesOf(db)]);
  const existing = new Map(cfgs.map((c) => [c.game_id, normalizeConfig(c)]));
  const name = new Map(games.map((g) => [g.id, g.name]));
  return { plan: planImport(rows, games, existing, (id) => name.get(id) ?? "another game"), errors };
}

/**
 * Applies a previewed import. create/fill rows are applied; needs_approval rows ONLY if their `line` is in `approvedLines`;
 * conflict / unknown / same rows never. Created configs are disabled + test mode; existing enabled/test_mode/caps are untouched.
 * The plan is recomputed here from the text — the browser's preview is never trusted.
 */
export async function applyIdImport(db: Db, text: string, approvedLines: number[], email: string | null): Promise<{ applied: number; skipped: number }> {
  const { plan } = await previewIdImport(db, text);
  const approved = new Set(approvedLines);
  const cfgs = new Map((await listAdsConfigs(db)).map((c) => [c.game_id, normalizeConfig(c)]));
  let applied = 0, skipped = 0;
  for (const item of plan) {
    const ok = item.gameId && (item.action === "create" || item.action === "fill" || (item.action === "needs_approval" && approved.has(item.line)));
    if (!ok || !item.gameId) { if (item.action !== "same") skipped++; continue; }
    const cur = cfgs.get(item.gameId) ?? testDefaultsEmpty();
    const next = normalizeConfig({ ...cur, [item.platform]: item.ids });
    await saveAdsConfig(db, item.gameId, next, email);
    cfgs.set(item.gameId, next);
    applied++;
  }
  return { applied, skipped };
}

const testDefaultsEmpty = () => normalizeConfig({ enabled: false, test_mode: true });
