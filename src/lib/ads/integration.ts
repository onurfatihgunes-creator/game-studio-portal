/**
 * Pure helpers for the advertising workflow: detecting the shared Unity module in a scanned repo, the per-game integration
 * checklist, cross-game ID uniqueness, and the ID import plan. No I/O here; the store and server actions call these.
 * Nothing in this file talks to AdMob or changes a game repository.
 */
import { APP_ID_RE, type AdsConfig, DEMO_APP_IDS, DEMO_UNITS, normalizeConfig, type PlatformIds, UNIT_ID_RE, validateConfig } from "./config";

export const MODULE_PACKAGE = "com.studio.ads";
export const GOOGLE_PLUGIN = "com.google.ads.mobile";
export const CONFIG_PATH = "Assets/Resources/StudioAdsConfig.json";

export type StudioAdsFacts = {
  /** version of the shared module found in the repo (vendored Packages/com.studio.ads or a manifest dependency); null = not installed */
  module_version: string | null;
  /** Assets/Resources/StudioAdsConfig.json exists (the file the module reads at runtime) */
  config_file: boolean;
};

/** Inputs are the raw texts GitHub returned (null = 404). A malformed file counts as "not found", never as a guess. */
export function detectStudioAds(input: { packageJson: string | null; manifest: string | null; configJson: string | null }): StudioAdsFacts {
  let version: string | null = null;
  try {
    const v = input.packageJson ? (JSON.parse(input.packageJson) as { name?: string; version?: string }) : null;
    if (v?.name === MODULE_PACKAGE) version = typeof v.version === "string" ? v.version : "unknown";
  } catch { /* ignore */ }
  if (!version) {
    try {
      const deps = input.manifest ? ((JSON.parse(input.manifest) as { dependencies?: Record<string, string> }).dependencies ?? {}) : {};
      if (MODULE_PACKAGE in deps) version = "referenced in manifest";
    } catch { /* ignore */ }
  }
  let config = false;
  try { config = !!input.configJson && typeof JSON.parse(input.configJson) === "object"; } catch { /* ignore */ }
  return { module_version: version, config_file: config };
}

// ── Cross-game uniqueness ───────────────────────────────────────────
const isDemoId = (id: string) => Object.values(DEMO_UNITS.android).includes(id as never) || Object.values(DEMO_UNITS.ios).includes(id as never) || id === DEMO_APP_IDS.android || id === DEMO_APP_IDS.ios || id.startsWith("ca-app-pub-3940256099942544");

function idsOf(cfg: Pick<AdsConfig, "android" | "ios">): { id: string; where: string }[] {
  const out: { id: string; where: string }[] = [];
  for (const p of ["android", "ios"] as const) for (const k of ["app_id", "rewarded", "interstitial", "banner"] as const) {
    const v = cfg[p][k];
    if (v) out.push({ id: v, where: `${p}.${k}` });
  }
  return out;
}

export type Conflict = { id: string; where: string; otherGameId: string; otherName: string };

/** An AdMob app or ad unit belongs to exactly one game. Google's shared demo IDs are exempt (every game may use them in test mode). */
export function findIdConflicts(gameId: string, cfg: AdsConfig, others: { gameId: string; name: string; cfg: AdsConfig }[]): Conflict[] {
  const mine = idsOf(cfg).filter((x) => !isDemoId(x.id));
  const out: Conflict[] = [];
  for (const o of others) {
    if (o.gameId === gameId) continue;
    const theirs = new Set(idsOf(o.cfg).map((x) => x.id));
    for (const m of mine) if (theirs.has(m.id)) out.push({ id: m.id, where: m.where, otherGameId: o.gameId, otherName: o.name });
  }
  return out;
}

// ── Per-game checklist ──────────────────────────────────────────────
export type CheckState = "ok" | "todo" | "warn" | "unknown";
export type ChecklistItem = { key: string; label: string; state: CheckState; detail: string };

export function integrationChecklist(game: { unity_detected: boolean; androidBundleId: string | null; studioAds: StudioAdsFacts | null; googlePlugin: boolean | null }, cfg: AdsConfig | null): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  const known = game.studioAds !== null;
  items.push(game.studioAds?.module_version
    ? { key: "module", label: "Shared ads module in the game", state: "ok", detail: `${MODULE_PACKAGE} ${game.studioAds.module_version}` }
    : { key: "module", label: "Shared ads module in the game", state: known ? "todo" : "unknown", detail: known ? "Not installed. Prepare it with the onboarding command below (opens a pull request; nothing is pushed to the default branch)." : "Not scanned yet. Refresh this game." });
  items.push(game.googlePlugin
    ? { key: "plugin", label: "Google Mobile Ads plugin", state: "ok", detail: GOOGLE_PLUGIN }
    : { key: "plugin", label: "Google Mobile Ads plugin", state: game.googlePlugin === null ? "unknown" : "todo", detail: game.googlePlugin === null ? "Not scanned yet." : "Not in Packages/manifest.json. Added by --with-google-plugin." });
  items.push(game.studioAds?.config_file
    ? { key: "file", label: "Runtime config file", state: "ok", detail: CONFIG_PATH }
    : { key: "file", label: "Runtime config file", state: known ? "todo" : "unknown", detail: known ? `${CONFIG_PATH} is missing. The onboarding command adds a disabled test-mode copy.` : "Not scanned yet." });
  if (!cfg) {
    items.push({ key: "ids", label: "AdMob IDs for this game", state: "todo", detail: "No configuration yet. Enter this game's own AdMob app and ad unit IDs, or import them." });
    return items;
  }
  const have = (p: PlatformIds) => !!(p.app_id && (p.rewarded || p.interstitial || p.banner));
  const own = (p: PlatformIds) => [p.app_id, p.rewarded, p.interstitial, p.banner].some((v) => v && !isDemoId(v));
  const wantsAndroid = !!game.androidBundleId;
  items.push(own(cfg.android)
    ? { key: "ids", label: "AdMob IDs for this game (Android)", state: have(cfg.android) ? "ok" : "warn", detail: have(cfg.android) ? "Own app ID and ad units set." : "Partially set: app ID and at least one ad unit are needed." }
    : { key: "ids", label: "AdMob IDs for this game (Android)", state: wantsAndroid ? "todo" : "warn", detail: "Only Google demo IDs or nothing. Real earnings need this game's own AdMob app and units." });
  const errs = validateConfig(cfg).filter((p) => p.level === "error");
  if (errs.length) items.push({ key: "valid", label: "Configuration valid", state: "warn", detail: errs[0].message });
  items.push(cfg.enabled && !cfg.test_mode
    ? { key: "prod", label: "Production ad requests", state: "warn", detail: "Enabled. Make sure this was an explicit decision." }
    : { key: "prod", label: "Production ad requests", state: "ok", detail: cfg.enabled ? "Enabled in test mode (Google demo ads only)." : "Off (default)." });
  if (game.studioAds?.config_file && cfg.enabled && !game.studioAds.module_version) items.push({ key: "mismatch", label: "Enabled without module", state: "warn", detail: "Ads are enabled in the portal but the module is not installed in the game." });
  return items;
}

/** Copy-ready onboarding command (dry run by default; --apply opens a pull request). Uses only the repo name from the portal. */
export function onboardCommand(fullName: string, withGoogle: boolean): string {
  return `tools/onboard.sh --with-ads${withGoogle ? " --with-google-plugin" : ""} ${fullName}`;
}

// ── ID import ───────────────────────────────────────────────────────
export type ImportRow = { game: string; platform: "android" | "ios"; ids: PlatformIds; line: number };
export type ParseResult = { rows: ImportRow[]; errors: string[] };

/**
 * CSV (or tab separated, e.g. pasted from a sheet): game, platform, app_id, banner, interstitial, rewarded. A header row is optional.
 * `game` is the repo full name (owner/repo), repo name or portal name. Ad unit cells may be empty.
 */
export function parseIdImport(text: string): ParseResult {
  const rows: ImportRow[] = [];
  const errors: string[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const c = line.split(/[,\t;]/).map((s) => s.trim());
    if (/^game$/i.test(c[0])) return;
    if (c.length < 3) { errors.push(`Line ${i + 1}: expected game, platform, app_id, banner, interstitial, rewarded.`); return; }
    const platform = c[1].toLowerCase();
    if (platform !== "android" && platform !== "ios") { errors.push(`Line ${i + 1}: platform must be android or ios.`); return; }
    const ids: PlatformIds = {};
    const [app, banner, interstitial, rewarded] = [c[2], c[3], c[4], c[5]].map((v) => (v ? v : undefined));
    if (app) { if (!APP_ID_RE.test(app)) { errors.push(`Line ${i + 1}: app ID is not well-formed.`); return; } ids.app_id = app; }
    for (const [k, v] of [["banner", banner], ["interstitial", interstitial], ["rewarded", rewarded]] as const) {
      if (!v) continue;
      if (!UNIT_ID_RE.test(v)) { errors.push(`Line ${i + 1}: ${k} unit ID is not well-formed.`); return; }
      ids[k] = v;
    }
    if (!ids.app_id) { errors.push(`Line ${i + 1}: app ID is required.`); return; }
    rows.push({ game: c[0], platform, ids, line: i + 1 });
  });
  return { rows, errors };
}

export type PlanAction = "create" | "fill" | "same" | "needs_approval" | "conflict" | "unknown_game";
export type PlanItem = { game: string; gameId: string | null; platform: "android" | "ios"; action: PlanAction; message: string; ids: PlatformIds; line: number };

type GameRef = { id: string; name: string; full_name: string; repo: string };
const findGame = (games: GameRef[], q: string) => {
  const s = q.toLowerCase();
  const hit = games.filter((g) => g.full_name.toLowerCase() === s || g.repo.toLowerCase() === s || g.name.toLowerCase() === s);
  return hit.length === 1 ? hit[0] : null;
};

/**
 * Decides, per row, what applying it would do — without doing it.
 *  create          no configuration yet: a new DISABLED, test-mode one is created.
 *  fill            the platform has only demo/empty IDs: they are replaced (nothing real is lost).
 *  same            identical to what is stored.
 *  needs_approval  the platform already has DIFFERENT own IDs: nothing changes unless the user approves overwriting that row.
 *  conflict        an ID is already used by another game (or twice in this import): never applied.
 */
export function planImport(rows: ImportRow[], games: GameRef[], existing: Map<string, AdsConfig>, nameOf: (id: string) => string): PlanItem[] {
  const plan: PlanItem[] = [];
  const seen = new Map<string, string>(); // id -> game id within this import
  for (const r of rows) {
    const g = findGame(games, r.game);
    const base = { game: r.game, platform: r.platform, ids: r.ids, line: r.line };
    if (!g) { plan.push({ ...base, gameId: null, action: "unknown_game", message: "No unique game with this name. Use owner/repo." }); continue; }
    const withId = { ...base, gameId: g.id };
    const idList = Object.values(r.ids);
    const dupWithin = idList.find((id) => seen.has(id) && seen.get(id) !== g.id);
    if (dupWithin) { plan.push({ ...withId, action: "conflict", message: `${dupWithin} is used twice in this import for different games.` }); continue; }
    const others = [...existing.entries()].map(([gameId, cfg]) => ({ gameId, name: nameOf(gameId), cfg }));
    const clash = findIdConflicts(g.id, normalizeConfig({ [r.platform]: r.ids } as Partial<AdsConfig>), others);
    if (clash.length) { plan.push({ ...withId, action: "conflict", message: `${clash[0].id} already belongs to ${clash[0].otherName}.` }); continue; }
    idList.forEach((id) => seen.set(id, g.id));
    const cur = existing.get(g.id);
    if (!cur) { plan.push({ ...withId, action: "create", message: "New configuration (disabled, test mode)." }); continue; }
    const have = cur[r.platform];
    const same = (Object.keys(r.ids) as (keyof PlatformIds)[]).every((k) => have[k] === r.ids[k]);
    if (same) { plan.push({ ...withId, action: "same", message: "Already stored." }); continue; }
    const hasOwn = Object.values(have).some((v) => v && !isDemoId(v));
    plan.push(hasOwn
      ? { ...withId, action: "needs_approval", message: "This platform already has different IDs. Nothing changes unless you approve this row." }
      : { ...withId, action: "fill", message: "Replaces demo/empty IDs." });
  }
  return plan;
}
