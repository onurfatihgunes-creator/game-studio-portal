import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RepoGit, PullRequest, FileChange } from "@/lib/github/repo-git";
import type { ModuleBundle } from "./bundle";
import { exportForUnity, type AdsConfig, normalizeConfig } from "./config";
import { findIdConflicts, ownIdPlatforms } from "./integration";
import { type AdsPolicy, policyCaps } from "./policy";
import type { ApplyResult } from "./apply-types";

/**
 * "Apply to All Games" for ONE game. Idempotent and conservative:
 *  - reads the game's repository, decides what (if anything) must change, and only then writes;
 *  - the only write is a commit on a dedicated branch + a pull request. It never merges and never touches the default branch;
 *  - the game's own AdMob IDs are the only IDs ever written; existing files and configs are never overwritten
 *    (managed module files are replaced only when the module version is older; existing config values are never changed);
 *  - a game that already has an open integration pull request is updated in place, not duplicated.
 */
export const INTEGRATION_BRANCH = "studio-ads-integration";
/** Branch used by the earlier onboarding tool (an existing pull request from that tool). Treated as ours so the work is reused. */
export const LEGACY_BRANCHES = ["studio-ci-onboarding"];
export const PR_MARKER = "<!-- studio-ads-integration -->";
const MODULE_DIR = "Packages/com.studio.ads/";
const CONFIG_PATH = "Assets/Resources/StudioAdsConfig.json";
const PLACEMENTS_PATH = "Assets/StudioAds/StudioAdsPlacements.json";

export type ApplyGame = { id: string; name: string; full_name: string; unity_detected: boolean; unity_project_path: string | null; is_archived: boolean };
export type ApplyDeps = {
  git: RepoGit;
  bundle: ModuleBundle;
  policy: AdsPolicy;
  /** public URL of the policy file (written into NEW game configs; added to existing configs only if absent) */
  remoteUrl: string;
  canWrite: boolean;
  /** configs of ALL other games, to prove no identifier is reused */
  others: { gameId: string; name: string; cfg: AdsConfig }[];
};

// ── small pure helpers (exported for tests) ──────────────────────────
export function cmpVersion(a: string, b: string): number {
  const n = (v: string) => v.split(/[.+-]/).slice(0, 3).map((x) => parseInt(x, 10) || 0);
  const [x, y] = [n(a), n(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

const guid = (fullName: string, path: string) => createHash("md5").update(`${fullName}:${path}`).digest("hex");
const meta = (g: string, importer: "folder" | "text") => importer === "folder"
  ? `fileFormatVersion: 2\nguid: ${g}\nfolderAsset: yes\nDefaultImporter:\n  externalObjects: {}\n  userData: \n  assetBundleName: \n  assetBundleVariant: \n`
  : `fileFormatVersion: 2\nguid: ${g}\nTextScriptImporter:\n  externalObjects: {}\n  userData: \n  assetBundleName: \n  assetBundleVariant: \n`;

/** Adds the OpenUPM registry (scope com.google) and the pinned Google plugin if absent. Never removes or changes anything else. */
export function patchManifest(text: string): { text: string; changed: boolean; notes: string[] } {
  const m = JSON.parse(text) as { dependencies?: Record<string, string>; scopedRegistries?: { name?: string; url?: string; scopes?: string[] }[] };
  const notes: string[] = [];
  m.dependencies ??= {};
  const regs = (m.scopedRegistries ??= []);
  const reg = regs.find((r) => r.url === "https://package.openupm.com");
  if (!reg) { regs.push({ name: "OpenUPM", url: "https://package.openupm.com", scopes: ["com.google"] }); notes.push("added the OpenUPM registry"); }
  else if (!(reg.scopes ?? []).includes("com.google")) { (reg.scopes ??= []).push("com.google"); notes.push("added scope com.google to the OpenUPM registry"); }
  if (!("com.google.ads.mobile" in m.dependencies)) { m.dependencies["com.google.ads.mobile"] = "11.5.0"; notes.push("added com.google.ads.mobile 11.5.0"); }
  return { text: JSON.stringify(m, null, 2) + "\n", changed: notes.length > 0, notes };
}

/** Adds missing keys to an existing config. Existing values (IDs, flags, caps) are NEVER changed. */
export function mergeConfigAdditive(existing: string, add: Record<string, unknown>): { text: string; changed: boolean } {
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(existing) as Record<string, unknown>; } catch { return { text: existing, changed: false }; }
  let changed = false;
  for (const [k, v] of Object.entries(add)) if (!(k in obj)) { obj[k] = v; changed = true; }
  return { text: changed ? JSON.stringify(obj, null, 2) + "\n" : existing, changed };
}

const ID_KEYS = [["appId", "app_id"], ["rewarded", "rewarded"], ["interstitial", "interstitial"], ["banner", "banner"]] as const;

/**
 * Writes the game's OWN identifiers into a config that still has them EMPTY (the safe, disabled config prepared before the IDs existed).
 * A non-empty value is never replaced, and only platforms where the game really has its own IDs are touched.
 */
export function fillEmptyIds(existing: string, own: AdsConfig | null): { text: string; changed: boolean } {
  let obj: Record<string, Record<string, string> | unknown>;
  try { obj = JSON.parse(existing) as Record<string, unknown>; } catch { return { text: existing, changed: false }; }
  let changed = false;
  for (const p of ownIdPlatforms(own)) {
    const section = ((obj[p] as Record<string, string> | undefined) ??= {});
    for (const [unityKey, ourKey] of ID_KEYS) {
      const mine = (own![p] as Record<string, string | undefined>)[ourKey];
      if (mine && !section[unityKey]) { section[unityKey] = mine; changed = true; }
    }
  }
  return { text: changed ? JSON.stringify(obj, null, 2) + "\n" : existing, changed };
}

/** The config for a NEW integration: this game's own IDs, disabled, test mode, policy baseline. */
export function buildNewConfig(own: AdsConfig | null, policy: AdsPolicy, remoteUrl: string): string {
  // a game with no IDs yet gets a safe, disabled configuration with EMPTY identifiers; nothing is invented or borrowed
  const cfg = normalizeConfig({
    enabled: false, test_mode: true,
    banner_enabled: policy.banner_enabled, banner_position: policy.banner_position,
    android: ownIdPlatforms(own).includes("android") ? own!.android : {}, ios: ownIdPlatforms(own).includes("ios") ? own!.ios : {},
    caps: policyCaps(policy), consent: own?.consent,
  });
  return JSON.stringify(exportForUnity(cfg, { remotePolicyUrl: remoteUrl, rewardedAvailable: policy.rewarded_available }), null, 2) + "\n";
}

const isOurs = (p: PullRequest) => p.head === INTEGRATION_BRANCH || LEGACY_BRANCHES.includes(p.head) || p.body.includes(PR_MARKER);

type RefState = { version: string | null; configText: string | null; remoteUrl: string | null; needsIds: boolean };

async function inspectRef(git: RepoGit, ref: string, root: string, own: AdsConfig | null): Promise<RefState> {
  const [pkg, cfg] = await Promise.all([git.readFile(`${root}${MODULE_DIR}package.json`, ref), git.readFile(`${root}${CONFIG_PATH}`, ref)]);
  let version: string | null = null;
  try { const v = pkg ? (JSON.parse(pkg) as { name?: string; version?: string }) : null; if (v?.name === "com.studio.ads") version = v.version ?? "0.0.0"; } catch { /* unreadable */ }
  let remoteUrl: string | null = null;
  try { const u = cfg ? (JSON.parse(cfg) as { remotePolicyUrl?: string }).remotePolicyUrl : null; remoteUrl = typeof u === "string" && u ? u : null; } catch { /* unreadable */ }
  return { version, configText: cfg, remoteUrl, needsIds: !!cfg && fillEmptyIds(cfg, own).changed };
}

const upToDate = (s: RefState, bundle: ModuleBundle) => !!s.version && cmpVersion(s.version, bundle.version) >= 0 && !!s.remoteUrl && !s.needsIds;

/** Game-specific placement hooks: declared in Assets/StudioAds/StudioAdsPlacements.json AND the declared file exists. */
async function readHooks(git: RepoGit, root: string, ref: string): Promise<boolean> {
  const text = await git.readFile(`${root}${PLACEMENTS_PATH}`, ref);
  if (!text) return false;
  try {
    const hooks = (JSON.parse(text) as { hooks?: unknown }).hooks;
    return typeof hooks === "string" && hooks.length > 0 && (await git.readFile(`${root}${hooks}`, ref)) !== null;
  } catch { return false; }
}

async function planFiles(deps: ApplyDeps, game: ApplyGame, own: AdsConfig | null, ref: string, root: string, state: RefState): Promise<{ files: FileChange[]; summary: string[] }> {
  const { git, bundle, policy, remoteUrl } = deps;
  const listing = await git.listPaths(ref);
  const exists = async (p: string) => listing.complete ? listing.paths.includes(p) : (await git.readFile(p, ref)) !== null;
  const files: FileChange[] = [];
  const summary: string[] = [];
  const fresh = state.version === null;

  // 1. the shared module (managed copy: replaced when older, never edited per game)
  for (const f of bundle.module) files.push({ path: root + f.path, content: f.content });
  if (listing.complete) {
    const keep = new Set(bundle.module.map((f) => root + f.path));
    for (const p of listing.paths) if (p.startsWith(root + MODULE_DIR) && !keep.has(p)) files.push({ path: p, content: null });
  }
  summary.push(fresh ? `adds ${MODULE_DIR} ${bundle.version}` : `updates ${MODULE_DIR} ${state.version} → ${bundle.version}`);

  // 2. the Google adapter + App-ID sync (managed; an existing file is only replaced on a module upgrade)
  for (const f of bundle.adapter) {
    const path = root + f.path;
    if (fresh && (await exists(path))) continue;
    files.push({ path, content: f.content });
  }
  if (bundle.folderMeta && !(await exists(`${root}Assets/StudioAds.meta`))) files.push({ path: `${root}Assets/StudioAds.meta`, content: bundle.folderMeta });
  summary.push("Google Mobile Ads adapter and App-ID sync in Assets/StudioAds");

  // 3. config: create if absent (this game's own IDs, disabled, test mode); otherwise add missing keys only
  if (state.configText === null) {
    files.push({ path: root + CONFIG_PATH, content: buildNewConfig(own, policy, remoteUrl) });
    files.push({ path: root + CONFIG_PATH + ".meta", content: meta(guid(game.full_name, CONFIG_PATH), "text") });
    const resourcesUsed = listing.paths.some((p) => p.startsWith(`${root}Assets/Resources/`));
    if (!resourcesUsed && !(await exists(`${root}Assets/Resources.meta`))) files.push({ path: `${root}Assets/Resources.meta`, content: meta(guid(game.full_name, "Assets/Resources"), "folder") });
    summary.push(ownIdPlatforms(own).length ? "a DISABLED, test-mode StudioAdsConfig.json with this game's own AdMob IDs" : "a DISABLED, test-mode StudioAdsConfig.json with EMPTY AdMob identifiers (this game has none yet; they are filled in later, never borrowed)");
  } else {
    const add: Record<string, unknown> = { remotePolicyUrl: remoteUrl, rewardedAvailable: policy.rewarded_available };
    const merged = mergeConfigAdditive(state.configText, add);
    const filled = fillEmptyIds(merged.text, own);
    if (merged.changed || filled.changed) {
      files.push({ path: root + CONFIG_PATH, content: filled.text });
      summary.push([merged.changed && "adds the remote-policy keys to the existing config", filled.changed && "fills this game's own AdMob IDs where the config still had them empty"].filter(Boolean).join("; ") + " (no existing value changed)");
    }
  }

  // 4. new integrations only: the Google plugin in the manifest and an (empty) placements declaration
  if (fresh) {
    const manifest = await git.readFile(`${root}Packages/manifest.json`, ref);
    if (manifest) {
      const p = patchManifest(manifest);
      if (p.changed) { files.push({ path: `${root}Packages/manifest.json`, content: p.text }); summary.push(`Packages/manifest.json: ${p.notes.join("; ")}`); }
    }
    if (!(await exists(root + PLACEMENTS_PATH))) {
      files.push({ path: root + PLACEMENTS_PATH, content: JSON.stringify({ schema: 1, hooks: null, placements: { banner: null, interstitial: null, rewarded: null } }, null, 2) + "\n" });
      files.push({ path: root + PLACEMENTS_PATH + ".meta", content: meta(guid(game.full_name, PLACEMENTS_PATH), "text") });
      summary.push("an empty StudioAdsPlacements.json (the game still needs its own placement hooks)");
    }
  }
  return { files, summary };
}

function prBody(game: ApplyGame, bundle: ModuleBundle, summary: string[], remoteUrl: string, fresh: boolean, hasIds: boolean): string {
  return `${PR_MARKER}
## Shared advertising module for ${game.name}

${fresh ? "Adds" : "Updates"} the studio's shared ads module (\`com.studio.ads\` **${bundle.version}**). Prepared by Game Studio Portal — **review it, nothing is merged or enabled automatically.**

**What changes**
${summary.map((s) => `- ${s}`).join("\n")}

**Safety**
- Ads stay **disabled** and in **test mode** (Google demo ads only). Production ads need a separate, explicit change.
- ${hasIds ? "Only this game's own AdMob identifiers are used." : "This game has no AdMob identifiers yet, so none are written (they stay empty until the game's own are saved in the portal)."} No other game's identifiers are involved.
- No gameplay, UI or scene file is edited.
- Remote policy (frequency caps, banner, rewarded availability) is fetched at runtime from \`${remoteUrl}\`; it can switch ads off or run test ads, never production.

**Still needed from the game**
- Game-specific placement hooks (which screens/events show a banner or interstitial). Declare them in \`Assets/StudioAds/StudioAdsPlacements.json\`.
`;
}

const result = (game: ApplyGame, r: Partial<ApplyResult> & Pick<ApplyResult, "status" | "detail">): ApplyResult => ({
  gameId: game.id, name: game.name, fullName: game.full_name, action: "none", moduleVersion: null, hooks: null, prNumber: null, prUrl: null, branch: null, ...r,
});

/**
 * Applies the shared advertising module to ONE game. A game WITHOUT its own AdMob IDs still gets the module and a safe, disabled
 * configuration with empty identifiers (so onboarding does not wait for AdMob), but it stays "Needs AdMob IDs" until it has its own.
 */
export async function applyToGame(deps: ApplyDeps, game: ApplyGame, own: AdsConfig | null): Promise<ApplyResult> {
  if (!game.unity_detected) return result(game, { status: "needs_integration", detail: "No Unity project was detected in this repository." });
  if (game.is_archived) return result(game, { status: "failed", detail: "The repository is archived on GitHub (read-only)." });
  const r = await prepareIntegration(deps, game, own);
  if (ownIdPlatforms(own).length > 0 || r.status === "failed") return r;
  const prepared = r.prNumber ? `Safe disabled integration prepared in pull request #${r.prNumber} (no identifiers written). ` : r.moduleVersion ? `Module ${r.moduleVersion} is in ${deps.git.defaultBranch} with a disabled configuration. ` : "";
  return { ...r, status: "needs_ids", detail: `${prepared}No AdMob app ID and ad units of its own are saved for this game yet. Add them on its AdMob IDs page.` };
}

async function prepareIntegration(deps: ApplyDeps, game: ApplyGame, own: AdsConfig | null): Promise<ApplyResult> {
  const { git, bundle } = deps;
  if (own) {
    const clash = findIdConflicts(game.id, own, deps.others);
    if (clash.length) return result(game, { status: "failed", detail: `${clash[0].id} already belongs to ${clash[0].otherName}. Each game needs its own AdMob identifiers.` });
  }

  try {
    const root = game.unity_project_path ? `${game.unity_project_path.replace(/\/$/, "")}/` : "";
    const def = await inspectRef(git, git.defaultBranch, root, own);
    const hooks = await readHooks(git, root, git.defaultBranch);
    const base = { moduleVersion: def.version, hooks };

    if (upToDate(def, bundle)) {
      return hooks
        ? result(game, { ...base, status: "applied", detail: `Module ${def.version} is in ${git.defaultBranch}, placement hooks are present and the remote policy is configured. Whether a released build contains it is not tracked here.` })
        : result(game, { ...base, status: "needs_integration", detail: `Module ${def.version} is in ${git.defaultBranch}, but no verified placement hooks were found (Assets/StudioAds/StudioAdsPlacements.json must name the game's hook file).` });
    }

    let open: PullRequest[];
    try { open = await git.openPullRequests(); }
    catch (e) {
      // pull requests are not even readable without the "Pull requests" permission
      if ((e as { status?: number }).status === 403) return result(game, { ...base, status: "failed", action: "blocked", detail: "The GitHub App has no Pull requests permission, so it cannot look for or create pull requests. Grant Contents and Pull requests: Read & write, then apply again." });
      throw e;
    }
    const pr = open.filter(isOurs).sort((a, b) => a.number - b.number)[0];

    if (pr) {
      const st = await inspectRef(git, pr.head, root, own);
      const common = { ...base, prNumber: pr.number, prUrl: pr.url, branch: pr.head };
      if (upToDate(st, bundle)) return result(game, { ...common, status: "pr_open", detail: `Pull request #${pr.number} already contains module ${st.version} and is awaiting your approval.` });
      if (!deps.canWrite) return result(game, { ...common, status: "failed", action: "blocked", detail: `Pull request #${pr.number} is outdated (${st.version ?? "no module"} → ${bundle.version}), but the GitHub App has no write permission to update it.` });
      const { files, summary } = await planFiles(deps, game, own, pr.head, root, st);
      await git.commit({ branch: pr.head, createFrom: git.defaultBranch, message: `Update studio ads module to ${bundle.version}`, files });
      // keep the existing description (it may carry the owner's review notes); only make sure the marker is there
      const note = `\n\n${PR_MARKER}\n_Updated by Game Studio Portal to module ${bundle.version}: ${summary.join("; ")}._`;
      await git.updatePullRequest(pr.number, { body: pr.body.includes(PR_MARKER) ? pr.body : pr.body + note }).catch(() => undefined);
      return result(game, { ...common, status: "pr_open", action: "updated_pr", detail: `Updated pull request #${pr.number} to module ${bundle.version}; awaiting your approval.` });
    }

    if (await git.branchExists(INTEGRATION_BRANCH)) {
      return result(game, { ...base, status: "failed", branch: INTEGRATION_BRANCH, detail: `Branch ${INTEGRATION_BRANCH} exists but has no open pull request (it may have been closed). Delete the branch on GitHub to prepare it again.` });
    }
    if (!deps.canWrite) return result(game, { ...base, status: "failed", action: "blocked", detail: "The GitHub App has no permission to create branches and pull requests. Grant it Contents and Pull requests: Read & write, then apply again." });

    const { files, summary } = await planFiles(deps, game, own, git.defaultBranch, root, def);
    await git.commit({ branch: INTEGRATION_BRANCH, createFrom: git.defaultBranch, message: `${def.version === null ? "Add" : "Update"} studio ads module ${bundle.version}`, files });
    const opened = await git.openPullRequest({
      head: INTEGRATION_BRANCH, base: git.defaultBranch,
      title: `Studio ads module ${bundle.version} (disabled, test mode)`,
      body: prBody(game, bundle, summary, deps.remoteUrl, def.version === null, ownIdPlatforms(own).length > 0),
    });
    return result(game, { ...base, status: "pr_open", action: "created_pr", prNumber: opened.number, prUrl: opened.url, branch: INTEGRATION_BRANCH, detail: `Opened pull request #${opened.number}; awaiting your approval.` });
  } catch (e) {
    return result(game, { status: "failed", detail: e instanceof Error ? e.message.slice(0, 400) : "Unexpected error" });
  }
}

// ── persistence ──────────────────────────────────────────────────────
export async function saveApplyResult(db: SupabaseClient, r: ApplyResult): Promise<void> {
  const { error } = await db.from("ads_apply_result").upsert({
    game_id: r.gameId, status: r.status, detail: r.detail, action: r.action, module_version: r.moduleVersion, hooks: r.hooks,
    pr_number: r.prNumber, pr_url: r.prUrl, branch: r.branch, updated_at: new Date().toISOString(),
  }, { onConflict: "game_id" });
  if (error) throw new Error(error.message);
}

export type StoredApply = { game_id: string; status: ApplyResult["status"]; detail: string | null; action: string | null; module_version: string | null; hooks: boolean | null; pr_number: number | null; pr_url: string | null; branch: string | null; updated_at: string };

export async function listApplyResults(db: SupabaseClient): Promise<StoredApply[]> {
  const { data, error } = await db.from("ads_apply_result").select("*");
  if (error) throw new Error(error.message);
  return (data ?? []) as StoredApply[];
}
