import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ScanResult } from "./github/types";
import type { DevStatus, GameRow, GameType, WorkflowRow } from "./types";

type Db = SupabaseClient;

export class DuplicateGameError extends Error {
  constructor(fullName: string) {
    super(`${fullName} is already connected.`);
    this.name = "DuplicateGameError";
  }
}

function gameFields(scan: ScanResult) {
  const c = scan.latestCommit;
  return {
    github_installation_id: scan.repo.installationId,
    github_repo_id: scan.repo.id,
    owner: scan.repo.owner,
    repo: scan.repo.name,
    full_name: scan.repo.fullName,
    html_url: scan.repo.htmlUrl,
    description: scan.repo.description,
    default_branch: scan.repo.defaultBranch,
    is_private: scan.repo.isPrivate,
    is_archived: scan.repo.isArchived,
    repo_pushed_at: scan.repo.pushedAt,
    unity_detected: scan.unity.detected,
    unity_version: scan.unity.version,
    unity_project_path: scan.unity.projectPath,
    unity_note: scan.unity.note,
    docs: scan.docs,
    monetization: scan.monetization,
    commit_sha: c?.sha ?? null,
    commit_message: c?.message ?? null,
    commit_author: c?.author ?? null,
    commit_at: c?.date ?? null,
    commit_url: c?.url ?? null,
    last_synced_at: scan.scannedAt,
    last_sync_error: null,
  };
}

function workflowRows(gameId: string, scan: ScanResult) {
  return scan.workflows.map((w) => ({
    game_id: gameId,
    github_workflow_id: w.githubWorkflowId,
    name: w.name,
    path: w.path,
    state: w.state,
    kinds: w.kinds,
    platforms: w.platforms,
    signals: w.signals,
    triggers: w.triggers,
    dispatchable: w.dispatchable,
    has_required_inputs: w.hasRequiredInputs,
    run_id: w.latestRun?.id ?? null,
    run_number: w.latestRun?.number ?? null,
    run_status: w.latestRun?.status ?? null,
    run_conclusion: w.latestRun?.conclusion ?? null,
    run_event: w.latestRun?.event ?? null,
    run_branch: w.latestRun?.branch ?? null,
    run_url: w.latestRun?.url ?? null,
    run_started_at: w.latestRun?.startedAt ?? null,
    run_updated_at: w.latestRun?.updatedAt ?? null,
  }));
}

async function replaceWorkflows(db: Db, gameId: string, scan: ScanResult) {
  const rows = workflowRows(gameId, scan);
  if (rows.length) {
    const { error } = await db.from("game_workflows").upsert(rows, { onConflict: "game_id,path" });
    if (error) throw new Error(`Saving workflows failed: ${error.message}`);
  }
  // Remove workflows that no longer exist in the repo.
  const keep = rows.map((r) => r.path);
  let del = db.from("game_workflows").delete().eq("game_id", gameId);
  if (keep.length) del = del.not("path", "in", `(${keep.map((p) => `"${p}"`).join(",")})`);
  const { error } = await del;
  if (error) throw new Error(`Cleaning workflows failed: ${error.message}`);
}

/** Create a game from a scan that the GitHub API has already answered successfully. */
export async function insertGame(
  db: Db,
  scan: ScanResult,
  user: { name: string; type: GameType; devStatus: DevStatus },
): Promise<string> {
  const { data, error } = await db
    .from("games")
    .insert({
      ...gameFields(scan),
      name: user.name,
      game_type: user.type,
      dev_status: user.devStatus,
      connected_at: scan.scannedAt,
    })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") throw new DuplicateGameError(scan.repo.fullName);
    throw new Error(`Saving game failed: ${error.message}`);
  }
  await replaceWorkflows(db, data.id, scan);
  return data.id;
}

export async function applyScan(db: Db, gameId: string, scan: ScanResult) {
  const { error } = await db.from("games").update(gameFields(scan)).eq("id", gameId);
  if (error) throw new Error(`Saving game failed: ${error.message}`);
  await replaceWorkflows(db, gameId, scan);
}

export async function recordSyncError(db: Db, gameId: string, message: string) {
  await db.from("games").update({ last_sync_error: message.slice(0, 500) }).eq("id", gameId);
}

export async function listGames(db: Db): Promise<GameRow[]> {
  const { data, error } = await db.from("games").select("*").order("name");
  if (error) throw new Error(error.message);
  return (data ?? []) as GameRow[];
}

export async function listWorkflows(db: Db, gameId?: string): Promise<WorkflowRow[]> {
  let q = db.from("game_workflows").select("*").order("name");
  if (gameId) q = q.eq("game_id", gameId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as WorkflowRow[];
}

export async function getGame(db: Db, id: string): Promise<GameRow | null> {
  const { data, error } = await db.from("games").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as GameRow | null) ?? null;
}

export function groupWorkflows(ws: WorkflowRow[]): Map<string, WorkflowRow[]> {
  const m = new Map<string, WorkflowRow[]>();
  for (const w of ws) m.set(w.game_id, [...(m.get(w.game_id) ?? []), w]);
  return m;
}
