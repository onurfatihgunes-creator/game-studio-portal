import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireGitHubConfig } from "./github/config";
import { scanRepository } from "./github/scan";
import { GitHubError } from "./github/app";
import { applyScan, DuplicateGameError, getGame, insertGame, listWorkflows, recordSyncError } from "./games";
import { schemaHint } from "./phase2";
import { syncGameBuilds } from "./github/runs";
import { DEV_STATUSES, type DevStatus, type GameType } from "./types";

/** Core add/refresh logic shared by the server actions (single add) and the /api/games routes (bulk). */

/** A failure that retrying cannot fix (e.g. the repository has no Unity project). */
export class PermanentImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentImportError";
  }
}

export type ImportFailure = "duplicate" | "rejected" | "retryable";

/**
 * duplicate  → already connected (not an error for the user)
 * rejected   → permanent: retrying changes nothing (no Unity project, invalid repo, repo not found/accessible)
 * retryable  → possibly temporary: GitHub 5xx / rate limit / network / database hiccup
 */
export function classifyImportError(e: unknown): ImportFailure {
  if (e instanceof DuplicateGameError) return "duplicate";
  if (e instanceof PermanentImportError) return "rejected";
  if (e instanceof GitHubError && (e.status === 404 || e.status === 401)) return "rejected";
  return "retryable";
}

const NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;

export function parseRepoRef(installationId: unknown, owner: unknown, repo: unknown) {
  const id = Number(installationId);
  if (!Number.isInteger(id) || id <= 0) throw new PermanentImportError("Invalid installation");
  if (typeof owner !== "string" || typeof repo !== "string" || !NAME_RE.test(owner) || !NAME_RE.test(repo)) {
    throw new PermanentImportError("Invalid repository");
  }
  return { id, owner, repo };
}

export type AddGameInput = {
  installationId: number; owner: string; repo: string; name: string; type: GameType; devStatus: DevStatus;
  /** Bulk import sets this: refuse repositories where the scan finds no Unity project (e.g. a shared engine repo). */
  requireUnity?: boolean;
};

/**
 * Re-scans on the server (never trusts browser-supplied scan data), then inserts.
 * Throws DuplicateGameError if the repository is already connected (unique github_repo_id).
 */
export async function addGame(db: SupabaseClient, input: AddGameInput): Promise<string> {
  const ref = parseRepoRef(input.installationId, input.owner, input.repo);
  const name = String(input.name ?? "").trim();
  if (!name || name.length > 120) throw new Error("Enter a game name (max 120 characters).");
  if (input.type !== "mini" && input.type !== "premium") throw new Error("Choose Mini or Premium.");
  if (!DEV_STATUSES.includes(input.devStatus)) throw new Error("Choose a development status.");

  const scan = await scanRepository(requireGitHubConfig(), ref.id, ref.owner, ref.repo);
  if (input.requireUnity && !scan.unity.detected) {
    throw new PermanentImportError("No Unity project found (no ProjectSettings/ProjectVersion.txt), so it was not imported. If this repository really is a game, add it with “Connect one game”.");
  }
  const id = await insertGame(db, scan, { name, type: input.type, devStatus: input.devStatus });
  await syncBuilds(db, id); // best effort: a build-sync problem must not undo a successful add
  return id;
}

/** Pull CI runs for a game. Never throws: problems are recorded on the game so the UI can show them. */
export async function syncBuilds(db: SupabaseClient, gameId: string): Promise<number> {
  try {
    const game = await getGame(db, gameId);
    if (!game) return 0;
    return await syncGameBuilds(db, requireGitHubConfig(), game, await listWorkflows(db, gameId));
  } catch (e) {
    await recordSyncError(db, gameId, schemaHint(`Build sync: ${e instanceof Error ? e.message : "failed"}`)).catch(() => undefined);
    return 0;
  }
}

/** Re-scan a connected game. Keeps old data and records the error if GitHub fails. */
export async function refreshGame(db: SupabaseClient, gameId: string): Promise<void> {
  const game = await getGame(db, gameId);
  if (!game) throw new Error("Game not found");
  try {
    const scan = await scanRepository(requireGitHubConfig(), game.github_installation_id, game.owner, game.repo);
    await applyScan(db, game.id, scan);
    await syncBuilds(db, game.id);
  } catch (e) {
    await recordSyncError(db, game.id, e instanceof Error ? e.message : "Refresh failed");
    throw e;
  }
}
