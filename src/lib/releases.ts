import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { canApprove, evaluateAndroid, evaluateIos, type Readiness } from "./ci/readiness";
import type { AdsConfig } from "./ads/config";
import { getAdsConfig } from "./ads/store";
import { getGame, listBuildRuns } from "./games";
import type { BuildRunRow, GameRow, ReleaseRow } from "./types";

type Db = SupabaseClient;
export type Actor = { id: string; email: string | null };

export async function listReleases(db: Db, opts: { gameId?: string; limit?: number } = {}): Promise<ReleaseRow[]> {
  let q = db.from("game_releases").select("*").order("created_at", { ascending: false }).limit(opts.limit ?? 100);
  if (opts.gameId) q = q.eq("game_id", opts.gameId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as ReleaseRow[];
}

export function evaluate(platform: "android" | "ios", game: GameRow, runs: BuildRunRow[], releases: ReleaseRow[], candidateRun?: BuildRunRow, ads?: AdsConfig | null): Readiness {
  return platform === "android" ? evaluateAndroid(game, runs, releases, candidateRun, ads) : evaluateIos(game, runs, releases, candidateRun, ads);
}

const PLATFORM_ACTIONS: Record<"android" | "ios", string[]> = { android: ["android-dev", "android-release"], ios: ["ios-validate"] };

/** Record a release CANDIDATE from a real, successful build run. Nothing is published or uploaded anywhere. */
export async function createCandidate(db: Db, input: { gameId: string; runId: string; platform: "android" | "ios" }): Promise<string> {
  const game = await getGame(db, input.gameId);
  if (!game) throw new Error("Game not found");
  const [runs, releases] = await Promise.all([listBuildRuns(db, { gameId: game.id }), listReleases(db, { gameId: game.id })]);
  const run = runs.find((r) => r.id === input.runId);
  if (!run) throw new Error("Build run not found for this game");
  if (!run.action || !PLATFORM_ACTIONS[input.platform].includes(run.action)) throw new Error(`A ${input.platform} candidate must come from ${PLATFORM_ACTIONS[input.platform].join(" or ")}.`);
  if (run.status !== "completed" || run.conclusion !== "success") throw new Error("Only a successful build can become a release candidate.");

  const f = game.project_facts;
  const version = run.version ?? f?.version ?? null;
  const buildNumber = run.build_number ?? (input.platform === "android" ? f?.androidVersionCode ?? null : f?.iosBuildNumber && /^\d+$/.test(f.iosBuildNumber) ? Number(f.iosBuildNumber) : null);
  if (!version || buildNumber === null) throw new Error("The version or build number of this build is unknown, so a candidate cannot be recorded.");

  const readiness = evaluate(input.platform, game, runs, releases, run, await getAdsConfig(db, game.id));
  const art = run.artifacts.find((a) => !a.expired);
  const { data, error } = await db.from("game_releases").insert({
    game_id: game.id, platform: input.platform, version, build_number: buildNumber, build_run_id: run.id,
    artifact_id: art?.id ?? null, artifact_name: art?.name ?? null, head_sha: run.head_sha,
    readiness: { checks: readiness.checks, blockers: readiness.blockers },
  }).select("id").single();
  if (error) {
    if (error.code === "23505") throw new Error(`A ${input.platform} candidate for v${version} (${buildNumber}) already exists.`);
    throw new Error(error.message);
  }
  return data.id;
}

export type Decision = "approve" | "reject" | "published_manually";

/**
 * A person decides. Approval re-evaluates readiness NOW and is refused while any check fails; it also needs the
 * game name typed. "published_manually" only records that someone uploaded the build to a store by hand.
 */
export async function decideRelease(db: Db, input: { releaseId: string; decision: Decision; typedName: string; notes?: string }, actor: Actor): Promise<void> {
  const { data: rel, error } = await db.from("game_releases").select("*").eq("id", input.releaseId).maybeSingle();
  if (error || !rel) throw new Error("Release candidate not found");
  const release = rel as ReleaseRow;
  const game = await getGame(db, release.game_id);
  if (!game) throw new Error("Game not found");
  if (input.typedName.trim() !== game.name) throw new Error("Type the game name exactly to confirm.");

  let status: ReleaseRow["status"];
  let readiness: ReleaseRow["readiness"] | undefined;
  if (input.decision === "approve") {
    if (release.status !== "candidate") throw new Error("Only a candidate can be approved.");
    const [runs, releases] = await Promise.all([listBuildRuns(db, { gameId: game.id }), listReleases(db, { gameId: game.id })]);
    const candidateRun = runs.find((r) => r.id === release.build_run_id);
    if (!candidateRun) throw new Error("The build run behind this candidate is no longer available.");
    const others = releases.filter((r) => r.id !== release.id);
    const now = evaluate(release.platform, game, runs, others, candidateRun, await getAdsConfig(db, game.id));
    if (!canApprove(now)) throw new Error(`Not approvable: ${now.checks.filter((c) => c.state === "fail").map((c) => c.label).join("; ")}.`);
    status = "approved";
    readiness = { checks: now.checks, blockers: now.blockers };
  } else if (input.decision === "reject") {
    if (release.status !== "candidate" && release.status !== "approved") throw new Error("This candidate is already final.");
    status = "rejected";
  } else {
    if (release.status !== "approved") throw new Error("Only an approved release can be marked as published manually.");
    status = "published_manually";
  }

  const { error: upErr } = await db.from("game_releases").update({
    status, decided_by: actor.id, decided_by_email: actor.email, decided_at: new Date().toISOString(),
    notes: input.notes?.slice(0, 500) ?? release.notes, ...(readiness ? { readiness } : {}),
  }).eq("id", release.id);
  if (upErr) throw new Error(upErr.message);
}
