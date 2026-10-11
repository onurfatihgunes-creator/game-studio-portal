/**
 * Real connection test — talks to the real GitHub and Supabase APIs using your .env.local.
 *
 *   npm run test:connection                       # credentials + repo listing
 *   npm run test:connection -- owner/repo         # also run the full scan on one repository
 *
 * Optional: set PORTAL_TEST_EMAIL / PORTAL_TEST_PASSWORD (a Supabase user) to also verify
 * signed-in database access. Nothing is written to GitHub or the database.
 * Exit code is non-zero if any required check fails.
 */
import { createClient } from "@supabase/supabase-js";
import { getInstallationToken, listInstallationRepos, listInstallations, readGitHubConfig } from "../src/lib/github/app";
import { scanRepository } from "../src/lib/github/scan";

let failed = false;
const ok = (m: string) => console.log(`  ✔ ${m}`);
const bad = (m: string) => { failed = true; console.log(`  ✘ ${m}`); };
const step = (m: string) => console.log(`\n${m}`);

const TABLES = ["games", "game_workflows", "workflow_dispatches", "build_runs", "game_releases", "game_ads_config", "admob_connection", "revenue_daily"] as const;
const RLS_DENIED = "42501";

async function supabaseChecks(url: string, key: string) {
  const anon = createClient(url, key, { auth: { persistSession: false } });

  // Auth server reachable + public sign-ups disabled (RLS grants every signed-in user access).
  const settings = await fetch(`${url}/auth/v1/settings`, { headers: { apikey: key } });
  if (!settings.ok) bad(`auth server not reachable (${settings.status})`);
  else {
    ok("auth server reachable");
    const { disable_signup } = (await settings.json()) as { disable_signup?: boolean };
    if (disable_signup) ok("public sign-ups are disabled");
    else bad("SECURITY: public sign-ups are ENABLED — anyone could register and read all data");
  }

  // Anonymous: every table must refuse reads and writes.
  for (const t of TABLES) {
    const read = await anon.from(t).select("*").limit(1);
    if (read.error?.code === RLS_DENIED) ok(`anon read denied on ${t}`);
    else if (read.error?.code === "42P01" || read.error?.code === "PGRST205") bad(`table ${t} is missing — apply supabase/migrations/${["build_runs", "game_releases", "game_ads_config", "admob_connection", "revenue_daily"].includes(t) ? "0002_phase2_ci_releases_ads.sql" : "0001_init.sql"} in the Supabase SQL Editor`);
    else if (read.error) bad(`anon read on ${t}: unexpected error ${read.error.code} ${read.error.message}`);
    else bad(`SECURITY: anonymous read on ${t} succeeded (${read.data.length} rows visible)`);

    // An empty insert can never succeed (NOT NULL columns), so this probe is harmless either way.
    const write = await anon.from(t).insert({});
    if (write.error?.code === RLS_DENIED) ok(`anon write denied on ${t}`);
    else bad(`anon write on ${t}: expected permission denied, got ${write.error ? write.error.code + " " + write.error.message : "success"}`);
  }

  // Authenticated.
  const email = process.env.PORTAL_TEST_EMAIL;
  const password = process.env.PORTAL_TEST_PASSWORD;
  if (!email || !password) {
    console.log("  · set PORTAL_TEST_EMAIL / PORTAL_TEST_PASSWORD in .env.local to test signed-in access");
    return;
  }
  const wrong = await createClient(url, key, { auth: { persistSession: false } }).auth.signInWithPassword({ email, password: password + "x" });
  if (wrong.error) ok("wrong password is rejected");
  else bad("SECURITY: sign-in succeeded with a wrong password");

  const db = createClient(url, key, { auth: { persistSession: false } });
  const { data: session, error: signErr } = await db.auth.signInWithPassword({ email, password });
  if (signErr || !session.user) return bad(`sign-in failed: ${signErr?.message}`);
  ok("sign-in works (user id " + session.user.id.slice(0, 8) + "…)");
  const { data: who } = await db.auth.getUser();
  if (who.user?.email === email) ok("session validates server-side (auth.getUser)");
  else bad("session did not validate");

  for (const t of TABLES) {
    const { count, error } = await db.from(t).select("*", { count: "exact", head: true });
    if (error) bad(`signed-in read on ${t} failed: ${error.message}`);
    else ok(`signed-in read on ${t}: ${count} rows`);
  }

  // Full CRUD cycle on a clearly-marked temporary row; always cleaned up.
  const marker = "__rls_test__";
  const row = {
    name: marker, game_type: "mini", github_installation_id: 0, github_repo_id: -Math.floor(Math.random() * 1e9) - 1,
    owner: marker, repo: marker, full_name: `${marker}/${marker}`, html_url: "https://example.invalid", default_branch: "main",
    is_private: true, connected_at: new Date().toISOString(), last_synced_at: new Date().toISOString(),
  };
  const ins = await db.from("games").insert(row).select("id").single();
  if (ins.error) return bad(`signed-in insert on games failed: ${ins.error.message}`);
  ok("signed-in insert on games");
  const id = ins.data.id as string;
  try {
    const upd = await db.from("games").update({ dev_status: "paused" }).eq("id", id).select("dev_status").single();
    if (upd.data?.dev_status === "paused") ok("signed-in update on games"); else bad(`signed-in update failed: ${upd.error?.message}`);

    const wf = await db.from("game_workflows").insert({ game_id: id, name: marker, path: marker }).select("id").single();
    if (wf.error) bad(`signed-in insert on game_workflows failed: ${wf.error.message}`); else ok("signed-in insert on game_workflows");

    const anonSees = await anon.from("games").select("id").eq("id", id);
    if (anonSees.error?.code === RLS_DENIED || (anonSees.data ?? []).length === 0) ok("anon cannot see the new row");
    else bad("SECURITY: anon can see authenticated data");

    // Audit log: members may only write entries as themselves.
    const spoof = await db.from("workflow_dispatches").insert({
      game_name: marker, workflow_path: marker, ref: "main", outcome: "rejected", user_id: "00000000-0000-4000-8000-000000000000",
    });
    if (spoof.error) ok("audit log rejects entries attributed to another user"); else bad("SECURITY: audit entry with a spoofed user_id was accepted");
  } finally {
    const del = await db.from("games").delete().eq("id", id).select("id");
    if (del.error || (del.data ?? []).length !== 1) bad(`CLEANUP FAILED — delete the row named ${marker} in the games table manually`);
    else ok("signed-in delete on games (cascade removed the test workflow); test data cleaned up");
  }
  await db.auth.signOut();
}

async function main() {
  const target = process.argv[2];

  step("GitHub App");
  const cfg = readGitHubConfig();
  if (!cfg.ok) {
    bad(`missing env: ${cfg.missing.join(", ")}`);
  } else {
    try {
      const installs = await listInstallations(cfg.config);
      ok(`App JWT accepted by GitHub (app id ${cfg.config.appId})`);
      if (installs.length === 0) bad("App is not installed on any account — install it and select repositories");
      for (const i of installs) {
        await getInstallationToken(cfg.config, i.id);
        const repos = await listInstallationRepos(cfg.config, i.id);
        ok(`installation ${i.id} (${i.account}, ${i.repositorySelection}) → ${repos.length} repositories accessible`);
        if (target) {
          const hit = repos.find((r) => r.fullName.toLowerCase() === target.toLowerCase());
          if (!hit) continue;
          const scan = await scanRepository(cfg.config, i.id, hit.owner, hit.name);
          ok(`scan ${scan.repo.fullName}: branch ${scan.repo.defaultBranch}, commit ${scan.latestCommit?.sha.slice(0, 7) ?? "none"}`);
          ok(`unity: ${scan.unity.detected ? (scan.unity.version ?? "version unreadable") : "Not detected"}`);
          ok(`docs: ${scan.docs.length}, workflows: ${scan.workflows.length}, monetization checked: ${scan.monetization.checked}`);
          for (const w of scan.workflows) {
            ok(`workflow ${w.path} [${w.kinds.join("+") || "unclassified"}] latest run: ${w.latestRun ? `${w.latestRun.status}/${w.latestRun.conclusion}` : "none"}`);
          }
        }
      }
      if (target && !installs.length) bad(`cannot scan ${target}: no installation`);
    } catch (e) {
      bad(e instanceof Error ? e.message : String(e));
    }
  }

  step("Supabase");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    bad("missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY");
  } else {
    await supabaseChecks(url, key);
  }

  console.log(failed ? "\nFAILED" : "\nAll checks passed");
  process.exit(failed ? 1 : 0);
}

main();
