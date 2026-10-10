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
    const anon = createClient(url, key, { auth: { persistSession: false } });
    const { data, error } = await anon.from("games").select("id").limit(1);
    if (error) bad(`games table not reachable (did you run the migration?): ${error.message}`);
    else if ((data ?? []).length > 0) bad("SECURITY: anonymous clients can read games — RLS is not enforced");
    else ok("migration applied; anonymous access returns no rows (RLS enforced)");

    const email = process.env.PORTAL_TEST_EMAIL;
    const password = process.env.PORTAL_TEST_PASSWORD;
    if (email && password) {
      const { error: signErr } = await anon.auth.signInWithPassword({ email, password });
      if (signErr) bad(`sign-in failed: ${signErr.message}`);
      else {
        const { count, error: readErr } = await anon.from("games").select("id", { count: "exact", head: true });
        if (readErr) bad(`signed-in read failed: ${readErr.message}`);
        else ok(`signed in as ${email}; ${count} games visible`);
      }
    } else {
      console.log("  · set PORTAL_TEST_EMAIL / PORTAL_TEST_PASSWORD to also test signed-in access");
    }
  }

  console.log(failed ? "\nFAILED" : "\nAll checks passed");
  process.exit(failed ? 1 : 0);
}

main();
