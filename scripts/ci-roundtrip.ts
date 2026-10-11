/**
 * Real CI round trip through the portal's own code, with the real GitHub App:
 *   classify the repo's shared-CI workflow → dispatch the `smoke` action → wait → sync the run → resolve the artifact download.
 *
 *   npm run test:ci-roundtrip -- owner/repo
 *
 * Only the `smoke` action is ever dispatched: it runs on a GitHub-hosted Linux runner (≈1 minute of included
 * minutes), executes NO Unity, and never builds, signs or publishes anything. Nothing is written to the database
 * (a capture-only stub receives the rows the portal would store).
 */
import { getInstallationToken, ghJson, ghRedirectLocation, listAllAccessibleRepos, readGitHubConfig } from "../src/lib/github/app";
import { dispatchWorkflow } from "../src/lib/github/dispatch";
import { scanRepository } from "../src/lib/github/scan";
import { syncGameBuilds } from "../src/lib/github/runs";
import type { GameRow, WorkflowRow } from "../src/lib/types";

const ok = (m: string) => console.log(`  ✔ ${m}`);
const die = (m: string): never => { console.log(`  ✘ ${m}`); process.exit(1); };

async function main() {
  const target = process.argv[2];
  if (!target || !/^[\w.-]+\/[\w.-]+$/.test(target)) die("usage: npm run test:ci-roundtrip -- owner/repo");
  const cfg = readGitHubConfig();
  if (!cfg.ok) return die(`missing env: ${cfg.missing.join(", ")}`);

  const repo = (await listAllAccessibleRepos(cfg.config)).find((r) => r.fullName.toLowerCase() === target.toLowerCase());
  if (!repo) return die(`${target} is not accessible to the GitHub App`);
  ok(`GitHub App can see ${repo.fullName}`);

  const scan = await scanRepository(cfg.config, repo.installationId, repo.owner, repo.name);
  const wf = scan.workflows.find((w) => w.ciRef && w.ciActions.includes("smoke") && w.dispatchable);
  if (!wf || wf.githubWorkflowId === null) return die("no dispatchable shared-CI workflow offering the `smoke` action was detected");
  ok(`classified ${wf.path}: ci_ref=${wf.ciRef}; actions=[${wf.ciActions.join(", ")}]; kinds=[${wf.kinds.join(", ")}]; platforms=[${wf.platforms.join(", ")}]`);

  const token = await getInstallationToken(cfg.config, repo.installationId);
  const base = `/repos/${repo.owner}/${repo.name}`;
  const prev = await ghJson<{ workflow_runs: { id: number }[] }>(token, `${base}/actions/workflows/${wf.githubWorkflowId}/runs?per_page=1`);
  const prevId = prev?.workflow_runs[0]?.id ?? 0;

  await dispatchWorkflow(cfg.config, repo.installationId, repo.owner, repo.name, wf.githubWorkflowId, scan.repo.defaultBranch, { action: "smoke" });
  ok(`dispatched action=smoke on ${scan.repo.defaultBranch} via the GitHub App (HTTP 204)`);

  let run: { id: number; status: string; conclusion: string | null; html_url: string } | undefined;
  const deadline = Date.now() + 6 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    const l = await ghJson<{ workflow_runs: { id: number; status: string; conclusion: string | null; html_url: string }[] }>(token, `${base}/actions/workflows/${wf.githubWorkflowId}/runs?per_page=3&event=workflow_dispatch`);
    run = l?.workflow_runs.find((r) => r.id > prevId);
    if (run?.status === "completed") break;
  }
  if (!run || run.status !== "completed") return die(`run did not complete in time (${run?.status ?? "not started"}) — check https://github.com/${repo.fullName}/actions`);
  ok(`run ${run.id} completed: ${run.conclusion} — ${run.html_url}`);

  // Sync with the portal's code into a capture-only DB.
  const rows: Record<string, unknown>[] = [];
  const db: any = { from: () => ({ select: () => ({ eq: () => ({ in: async () => ({ data: [], error: null }) }) }), upsert: async (r: Record<string, unknown>) => { rows.push(r); return { error: null }; } }) };
  const game = { id: "roundtrip", owner: repo.owner, repo: repo.name, github_installation_id: repo.installationId } as GameRow;
  const w = { path: wf.path, ci_ref: wf.ciRef, github_workflow_id: wf.githubWorkflowId } as WorkflowRow;
  await syncGameBuilds(db, cfg.config, game, [w]);
  const row = rows.find((r) => r.github_run_id === run!.id) as any;
  if (!row) return die("the portal's sync did not produce a row for the run");
  ok(`synced → action=${row.action} conclusion=${row.conclusion} duration=${row.duration_s}s sha=${String(row.head_sha).slice(0, 7)} failed_step=${row.failed_step ?? "none"}`);
  ok(`result file parsed: ${row.summary ? JSON.stringify({ notes: row.summary.notes }) : "NO (portal-result missing or invalid)"}`);
  if (!row.summary || row.action !== "smoke" || row.conclusion !== "success") return die("expected action=smoke, success, with a valid portal-result");
  ok(`artifacts offered for download: ${row.artifacts.map((a: any) => `${a.name} (${a.size_bytes} B)`).join(", ") || "none"}`);

  const art = row.artifacts[0];
  if (art) {
    const loc = await ghRedirectLocation(token, `${base}/actions/artifacts/${art.id}/zip`);
    ok(loc ? `artifact download resolves to a short-lived signed URL on ${new URL(loc).host}` : "artifact download redirect NOT available");
    if (!loc) process.exit(1);
  }
  console.log("\nRound trip passed.");
}
main().catch((e) => { console.log(`  ✘ ${e instanceof Error ? e.message : e}`); process.exit(1); });
