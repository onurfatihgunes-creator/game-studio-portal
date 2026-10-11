import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getInstallationAccess, canWritePullRequests } from "@/lib/github/app";
import { requireGitHubConfig } from "@/lib/github/config";
import { githubRepoGit } from "@/lib/github/repo-git";
import { getGame } from "@/lib/games";
import { applyToGame, saveApplyResult } from "./apply";
import type { ApplyResult } from "./apply-types";
import { loadModuleBundle } from "./bundle";
import { normalizeConfig } from "./config";
import { type AdsPolicy } from "./policy";
import { getStoredPolicy, policyPublicUrl, publishPolicy, type PublishResult } from "./policy-store";
import { getAdsConfig, listAdsConfigs } from "./store";

/** Step 1 of "Apply to All Games": save + publish the shared policy (idempotent). */
export function prepareApply(db: SupabaseClient, policy: Partial<AdsPolicy>, email: string | null): Promise<PublishResult> {
  return publishPolicy(db, policy, email);
}

/** Step 2, once per game: inspect the repository and, only if needed, prepare/update its pull request. Never throws; the result is stored. */
export async function applyOneGame(db: SupabaseClient, gameId: string): Promise<ApplyResult> {
  const game = await getGame(db, gameId);
  if (!game) throw new Error("Game not found");
  const remoteUrl = policyPublicUrl();
  if (!remoteUrl) throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set.");
  const access = await getInstallationAccess(requireGitHubConfig(), game.github_installation_id);
  const [bundle, stored, own, all, names] = await Promise.all([
    loadModuleBundle(access.token),
    getStoredPolicy(db),
    getAdsConfig(db, game.id),
    listAdsConfigs(db),
    db.from("games").select("id,name"),
  ]);
  const name = new Map((names.data ?? []).map((g) => [g.id as string, g.name as string]));
  const result = await applyToGame(
    {
      git: githubRepoGit(access.token, game.owner, game.repo, game.default_branch),
      bundle, policy: stored.policy, remoteUrl, canWrite: canWritePullRequests(access.permissions),
      others: all.filter((r) => r.game_id !== game.id).map((r) => ({ gameId: r.game_id, name: name.get(r.game_id) ?? "another game", cfg: normalizeConfig(r) })),
    },
    game,
    own ? normalizeConfig(own) : null,
  );
  await saveApplyResult(db, result);
  return result;
}

/** For the page banner: may the GitHub App create branches and pull requests? null = could not tell. */
export async function writeAccess(installationId: number): Promise<boolean | null> {
  try {
    return canWritePullRequests((await getInstallationAccess(requireGitHubConfig(), installationId)).permissions);
  } catch {
    return null;
  }
}
