import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { exportForUnity, normalizeConfig, testDefaults, validateConfig } from "./ads/config";
import { getAdsConfig, saveAdsConfig } from "./ads/store";
import { unityAutomationAllowed } from "./ci/policy";
import { addGame, syncBuilds } from "./game-sync";
import { getGame, listBuildRuns, listWorkflows } from "./games";
import { listAllAccessibleRepos, readGitHubConfig } from "./github/app";
import { phase2Ready } from "./phase2";
import { readAdMobEnv } from "./revenue/admob";

export type Step = { name: string; ok: boolean; detail: string };

const PAGES: { path: string; expect: string }[] = [
  { path: "/", expect: "Overview" },
  { path: "/games", expect: "Games" },
  { path: "/games/new", expect: "Connect a game" },
  { path: "/games/import", expect: "Import games" },
  { path: "/releases", expect: "Releases" },
  { path: "/revenue", expect: "Revenue" },
];

/** Read-only checks with the caller's real session: schema state, configuration, and every page rendering. */
export async function deepChecks(db: SupabaseClient, origin: string, cookie: string): Promise<Step[]> {
  const steps: Step[] = [];
  const add = (name: string, ok: boolean, detail: string) => steps.push({ name, ok, detail });

  const ready = await phase2Ready(db);
  add("migration 0002 applied", ready, ready ? "Phase 02 tables are present" : "NOT applied — run supabase/migrations/0002_phase2_ci_releases_ads.sql in the SQL Editor");
  const { data: games, error } = await db.from("games").select("id,name,project_facts,unity_detected");
  add("games readable with your session (RLS)", !error, error ? error.message : `${games?.length ?? 0} game(s)`);
  if (ready && games?.length) add("games.project_facts column", games.every((g) => g.project_facts !== undefined), "present on every game row");
  for (const t of ["build_runs", "game_releases", "game_ads_config", "admob_connection", "revenue_daily"]) {
    if (!ready) break;
    const { error: e, count } = await db.from(t).select("*", { head: true, count: "exact" });
    add(`table ${t} readable`, !e, e ? e.message : `${count ?? 0} row(s)`);
  }

  const gh = readGitHubConfig();
  add("GitHub App configured", gh.ok, gh.ok ? "app id + private key present" : `missing ${gh.missing.join(", ")}`);
  const am = readAdMobEnv();
  add("AdMob OAuth configured", true, am.ok ? "client id/secret + encryption key present" : `not yet — missing ${am.missing.join(", ")} (expected until you create the Google client)`);
  add("Unity automation gate", !unityAutomationAllowed(), unityAutomationAllowed() ? "ENABLED (UNITY_AUTOMATION_ALLOWED=true)" : "blocked (default) — Unity actions refused server-side");

  const pages = [...PAGES];
  if (games?.[0]) pages.push({ path: `/games/${games[0].id}`, expect: ready ? "Builds & tests" : "Database update needed" }, { path: `/games/${games[0].id}/ads`, expect: ready ? "Advertising" : "Database update needed" });
  for (const p of pages) {
    try {
      const res = await fetch(new URL(p.path, origin), { headers: { cookie }, cache: "no-store", redirect: "manual" });
      // React escapes "&" as "&amp;" in HTML, so compare against the decoded text.
      const html = res.status === 200 ? (await res.text()).replace(/&amp;/g, "&") : "";
      const bad = /Application error|Internal Server Error|Unhandled Runtime Error/i.test(html);
      add(`page ${p.path}`, res.status === 200 && html.includes(p.expect) && !bad, `HTTP ${res.status}${res.status === 200 ? (html.includes(p.expect) ? `, shows “${p.expect}”` : `, MISSING “${p.expect}”`) : ""}${bad ? ", error marker found" : ""}`);
    } catch (e) {
      add(`page ${p.path}`, false, e instanceof Error ? e.message : "request failed");
    }
  }
  return steps;
}

/**
 * End-to-end exercise against ONE repository the GitHub App can see (intended: the private CI pilot copy):
 * connect it (or reuse it), dispatch the Unity-free self-test through the portal's own action, wait, sync, check the
 * result file and artifact download, prove the Unity gate blocks Unity actions, exercise ad config persistence /
 * validation / export, then remove the game record again if this run created it. Never touches the repository itself.
 */
export async function exercise(db: SupabaseClient, repoFullName: string, origin: string, cookie: string, user: { id: string; email: string | null }): Promise<Step[]> {
  const steps: Step[] = [];
  const add = (name: string, ok: boolean, detail: string) => steps.push({ name, ok, detail });
  const cfg = readGitHubConfig();
  if (!cfg.ok) return [{ name: "GitHub App configured", ok: false, detail: `missing ${cfg.missing.join(", ")}` }];
  if (!(await phase2Ready(db))) return [{ name: "migration 0002 applied", ok: false, detail: "apply the migration first" }];

  const repo = (await listAllAccessibleRepos(cfg.config)).find((r) => r.fullName.toLowerCase() === repoFullName.toLowerCase());
  if (!repo) return [{ name: "repository accessible to the GitHub App", ok: false, detail: repoFullName }];
  add("repository accessible to the GitHub App", true, repo.fullName);

  let gameId: string | null = null; let created = false;
  try {
    const existing = await db.from("games").select("id").eq("github_repo_id", repo.id).maybeSingle();
    if (existing.data) { gameId = existing.data.id as string; add("game record", true, "reusing an existing record (will not be deleted)"); }
    else { gameId = await addGame(db, { installationId: repo.installationId, owner: repo.owner, repo: repo.name, name: `E2E ${repo.name}`, type: "mini", devStatus: "prototype", requireUnity: true }); created = true; add("add game through the real scan + insert", true, `created ${gameId}`); }

    const wfs = await listWorkflows(db, gameId);
    const ci = wfs.find((w) => w.ci_ref && w.ci_actions.includes("smoke"));
    add("shared-CI workflow detected", !!ci, ci ? `${ci.path} → actions [${ci.ci_actions.join(", ")}]` : "no shared-CI caller with a smoke action found");
    if (!ci) return steps;
    const facts = (await getGame(db, gameId))?.project_facts;
    add("project facts stored", !!facts?.checked, facts?.checked ? `bundle ${facts.androidBundleId}, version ${facts.version}` : "not read");

    // The Unity gate, proven through the real server action (nothing is dispatched).
    const { triggerWorkflowAction } = await import("@/app/(portal)/releases/actions");
    if (!unityAutomationAllowed()) {
      const r = await triggerWorkflowAction({ workflowRowId: ci.id, confirmed: true, action: "test-editmode" });
      add("Unity action refused by the gate", !r.ok && /switched off/.test(r.ok ? "" : r.error), r.ok ? "DISPATCHED (gate failed!)" : r.error);
    }

    // Self-test through the portal's own dispatch path.
    const before = new Set((await listBuildRuns(db, { gameId, limit: 50 })).map((r) => r.github_run_id));
    const t0 = Date.now();
    const dispatched = await triggerWorkflowAction({ workflowRowId: ci.id, confirmed: true, action: "smoke" });
    add("self-test dispatched via portal action", dispatched.ok, dispatched.ok ? "accepted by GitHub" : dispatched.error);
    if (!dispatched.ok) return steps;

    let run = (await listBuildRuns(db, { gameId, limit: 50 })).find((r) => !before.has(r.github_run_id) && r.action === "smoke");
    while (Date.now() - t0 < 4 * 60_000 && (!run || run.status !== "completed")) {
      await new Promise((r) => setTimeout(r, 3000));
      await syncBuilds(db, gameId);
      run = (await listBuildRuns(db, { gameId, limit: 50 })).find((r) => !before.has(r.github_run_id) && r.action === "smoke");
    }
    add("run synced into build_runs", !!run && run.status === "completed", run ? `run #${run.run_number} ${run.status}/${run.conclusion ?? "-"} in ${run.duration_s ?? "?"}s on ${run.head_sha?.slice(0, 7)}` : "run never appeared");
    if (run?.status === "completed") {
      add("run succeeded", run.conclusion === "success", run.conclusion ?? "?");
      add("portal-result.json parsed", !!run.summary && run.summary.notes.some((n) => /no Unity was executed/.test(n)), run.summary ? run.summary.notes[0] : "no valid result file");
      const art = run.artifacts.find((a) => !a.expired);
      add("artifact recorded", !!art, art ? `${art.name} (${art.size_bytes} B)` : "none");
      if (art) {
        const res = await fetch(new URL(`/api/artifacts/${gameId}/${art.id}`, origin), { headers: { cookie }, redirect: "manual", cache: "no-store" });
        const loc = res.headers.get("location") ?? "";
        add("artifact download route → signed URL", res.status === 302 && /^https:\/\//.test(loc) && res.headers.get("cache-control") === "no-store", `HTTP ${res.status} → ${loc ? new URL(loc).host : "no location"}`);
        const wrong = await fetch(new URL(`/api/artifacts/${gameId}/1`, origin), { headers: { cookie }, redirect: "manual", cache: "no-store" });
        add("download refuses an artifact id not recorded for this game", wrong.status === 404, `HTTP ${wrong.status}`);
      }
    }

    // Advertising: validation, persistence, export.
    const bad = normalizeConfig({ ...testDefaults(), enabled: true, test_mode: false });
    let rejected = false; try { await saveAdsConfig(db, gameId, bad, user.email); } catch { rejected = true; }
    add("invalid production config (demo IDs) rejected on save", rejected && validateConfig(bad).some((p) => p.level === "error"), rejected ? "rejected" : "ACCEPTED (bad)");
    const good = normalizeConfig({ ...testDefaults(), enabled: true, test_mode: true, banner_enabled: true });
    await saveAdsConfig(db, gameId, good, user.email);
    const back = await getAdsConfig(db, gameId);
    add("ads config persisted and read back", !!back && back.enabled && back.test_mode && back.android.rewarded === good.android.rewarded && back.caps.interstitial_min_interval_s === good.caps.interstitial_min_interval_s, back ? "round-trip matches" : "not found");
    const ex = await fetch(new URL(`/api/ads/${gameId}/export`, origin), { headers: { cookie }, cache: "no-store" });
    const exJson = ex.status === 200 ? await ex.json() : null;
    add("ads JSON export matches the Unity contract", !!exJson && JSON.stringify(exJson) === JSON.stringify(exportForUnity(normalizeConfig(back ?? good))) && exJson.schema === 1 && exJson.testMode === true,
      exJson ? `schema ${exJson.schema}, testMode ${exJson.testMode}, content-disposition ${ex.headers.get("content-disposition")}` : `HTTP ${ex.status}`);
  } catch (e) {
    add("exercise aborted", false, e instanceof Error ? e.message : "error");
  } finally {
    if (gameId && created) {
      const { error } = await db.from("games").delete().eq("id", gameId);
      add("cleanup: test game removed", !error, error ? `DELETE FAILED — remove "E2E ${repo.name}" in the portal: ${error.message}` : "removed (cascade deleted its runs and ad config)");
    }
  }
  return steps;
}
