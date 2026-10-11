import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { actionFromTitle } from "../ci/actions";
import { readPortalResultZip, type PortalResult } from "../ci/result";
import type { GameRow, WorkflowRow } from "../types";
import { getInstallationToken, ghJson, ghRedirectLocation, type GitHubConfig } from "./app";

type RawRun = {
  id: number; run_number: number; run_attempt: number; status: string | null; conclusion: string | null; event: string;
  head_sha: string; head_branch: string | null; html_url: string; display_title?: string; name?: string | null;
  run_started_at: string | null; created_at: string; updated_at: string;
};
type RawJob = { name: string; status: string; conclusion: string | null; started_at: string | null; completed_at: string | null; steps?: { name: string; conclusion: string | null }[] };
type RawArtifact = { id: number; name: string; size_in_bytes: number; expired: boolean; expires_at: string | null };

export type StoredArtifact = { id: number; name: string; size_bytes: number; expired: boolean; expires_at: string | null };

const RESULT_ARTIFACT = /^portal-result/;
export const RUNS_PER_WORKFLOW = 10;

export function jobsSummary(jobs: RawJob[]) {
  const starts = jobs.flatMap((j) => (j.started_at ? [Date.parse(j.started_at)] : []));
  const ends = jobs.flatMap((j) => (j.completed_at ? [Date.parse(j.completed_at)] : []));
  const failedJob = jobs.find((j) => j.conclusion === "failure" || j.conclusion === "timed_out");
  const failedStep = failedJob?.steps?.find((s) => s.conclusion === "failure" || s.conclusion === "timed_out");
  return {
    durationS: starts.length && ends.length ? Math.max(0, Math.round((Math.max(...ends) - Math.min(...starts)) / 1000)) : null,
    failedJob: failedJob?.name ?? null,
    failedStep: failedStep?.name ?? null,
  };
}

export async function downloadArtifactZip(token: string, base: string, artifactId: number): Promise<Uint8Array | null> {
  const loc = await ghRedirectLocation(token, `${base}/actions/artifacts/${artifactId}/zip`);
  if (!loc) return null;
  const res = await fetch(loc, { cache: "no-store" }); // signed URL: no GitHub credentials are sent
  if (!res.ok) return null;
  const buf = new Uint8Array(await res.arrayBuffer());
  return buf.byteLength > 1024 * 1024 ? null : buf;
}

/** Row for build_runs from GitHub data. Pure so it can be unit-tested. */
export function buildRunRow(gameId: string, workflowPath: string, run: RawRun, jobs: RawJob[], artifacts: RawArtifact[], result: PortalResult | null) {
  const j = jobsSummary(jobs);
  const started = run.run_started_at ?? run.created_at;
  const completed = run.status === "completed" ? run.updated_at : null;
  const title = run.display_title ?? run.name ?? null;
  return {
    game_id: gameId,
    github_run_id: run.id,
    workflow_path: workflowPath,
    action: result?.action ?? actionFromTitle(title),
    title: title?.slice(0, 200) ?? null,
    head_sha: run.head_sha,
    head_branch: run.head_branch,
    event: run.event,
    status: run.status,
    conclusion: run.conclusion,
    run_number: run.run_number,
    run_attempt: run.run_attempt,
    html_url: run.html_url,
    started_at: started,
    completed_at: completed,
    duration_s: j.durationS ?? (completed ? Math.max(0, Math.round((Date.parse(completed) - Date.parse(started)) / 1000)) : null),
    failed_job: j.failedJob,
    failed_step: j.failedStep,
    version: result?.version ?? null,
    build_number: result?.buildNumber ?? null,
    bundle_id: result?.bundleId ?? null,
    unity_version: result?.unityVersion ?? null,
    summary: result ? { tests: result.tests ?? null, errorSummary: result.errorSummary ?? null, artifacts: result.artifacts ?? [], notes: result.notes ?? [] } : null,
    artifacts: artifacts.filter((a) => !RESULT_ARTIFACT.test(a.name)).map<StoredArtifact>((a) => ({ id: a.id, name: a.name, size_bytes: a.size_in_bytes, expired: a.expired, expires_at: a.expires_at })),
    synced_at: new Date().toISOString(),
  };
}

/**
 * Pull recent runs of each shared-CI workflow of a game into build_runs.
 * Completed runs are immutable, so details (jobs, artifacts, result file) are fetched only for runs that are
 * new or were not completed at the last sync. Returns the number of rows written.
 */
export async function syncGameBuilds(db: SupabaseClient, cfg: GitHubConfig, game: GameRow, workflows: WorkflowRow[]): Promise<number> {
  const ci = workflows.filter((w) => w.ci_ref && w.github_workflow_id !== null);
  if (ci.length === 0) return 0;
  const token = await getInstallationToken(cfg, game.github_installation_id);
  const base = `/repos/${encodeURIComponent(game.owner)}/${encodeURIComponent(game.repo)}`;
  let written = 0;

  for (const w of ci) {
    const list = await ghJson<{ workflow_runs: RawRun[] }>(token, `${base}/actions/workflows/${w.github_workflow_id}/runs?per_page=${RUNS_PER_WORKFLOW}`);
    const runs = list?.workflow_runs ?? [];
    if (runs.length === 0) continue;

    const { data: existing } = await db.from("build_runs").select("github_run_id,status,conclusion").eq("game_id", game.id).in("github_run_id", runs.map((r) => r.id));
    const have = new Map((existing ?? []).map((e) => [Number(e.github_run_id), e as { status: string | null; conclusion: string | null }]));

    for (const run of runs) {
      const prev = have.get(run.id);
      if (prev && prev.status === "completed" && prev.conclusion === run.conclusion) continue;

      const [jobsRes, artsRes] = await Promise.all([
        ghJson<{ jobs: RawJob[] }>(token, `${base}/actions/runs/${run.id}/jobs?per_page=30`),
        ghJson<{ artifacts: RawArtifact[] }>(token, `${base}/actions/runs/${run.id}/artifacts?per_page=30`),
      ]);
      const artifacts = artsRes?.artifacts ?? [];
      let result: PortalResult | null = null;
      const resultArtifact = artifacts.find((a) => RESULT_ARTIFACT.test(a.name) && !a.expired);
      if (run.status === "completed" && resultArtifact) {
        const zip = await downloadArtifactZip(token, base, resultArtifact.id).catch(() => null);
        result = zip ? readPortalResultZip(zip) : null;
      }
      const row = buildRunRow(game.id, w.path, run, jobsRes?.jobs ?? [], artifacts, result);
      const { error } = await db.from("build_runs").upsert(row, { onConflict: "game_id,github_run_id" });
      if (error) throw new Error(`Saving build run failed: ${error.message}`);
      written++;
    }
  }
  return written;
}
