import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ScanResult } from "./github/types";
import { schemaHint } from "./schema";
import type { DevStatus, GameRow, GameType } from "./types";

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
    project_facts: scan.projectFacts,
    commit_sha: c?.sha ?? null,
    commit_message: c?.message ?? null,
    commit_author: c?.author ?? null,
    commit_at: c?.date ?? null,
    commit_url: c?.url ?? null,
    last_synced_at: scan.scannedAt,
    last_sync_error: null,
  };
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
    throw new Error(schemaHint(`Saving game failed: ${error.message}`));
  }
  return data.id;
}

export async function applyScan(db: Db, gameId: string, scan: ScanResult) {
  const { error } = await db.from("games").update(gameFields(scan)).eq("id", gameId);
  if (error) throw new Error(schemaHint(`Saving game failed: ${error.message}`));
}

export async function recordSyncError(db: Db, gameId: string, message: string) {
  await db.from("games").update({ last_sync_error: message.slice(0, 500) }).eq("id", gameId);
}

export async function listGames(db: Db): Promise<GameRow[]> {
  const { data, error } = await db.from("games").select("*").order("name");
  if (error) throw new Error(error.message);
  return (data ?? []) as GameRow[];
}

export async function getGame(db: Db, id: string): Promise<GameRow | null> {
  const { data, error } = await db.from("games").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as GameRow | null) ?? null;
}
