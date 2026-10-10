"use server";

import { revalidatePath } from "next/cache";
import { requireGitHubConfig } from "@/lib/github/config";
import { scanRepository } from "@/lib/github/scan";
import type { ScanResult } from "@/lib/github/types";
import { addGame, parseRepoRef, refreshGame } from "@/lib/game-sync";
import { getGame } from "@/lib/games";
import { requireUser } from "@/lib/supabase/server";
import { DEV_STATUSES, type DevStatus, type GameType } from "@/lib/types";

export type ActionResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };

const msg = (e: unknown) => (e instanceof Error ? e.message : "Unexpected error");

/** Step 2 — Scan project. Read-only against GitHub, writes nothing. */
export async function scanRepoAction(installationId: number, owner: string, repo: string): Promise<ActionResult<{ scan: ScanResult; alreadyConnectedId: string | null }>> {
  try {
    const { supabase } = await requireUser();
    const ref = parseRepoRef(installationId, owner, repo);
    const scan = await scanRepository(requireGitHubConfig(), ref.id, ref.owner, ref.repo);
    const { data } = await supabase.from("games").select("id").eq("github_repo_id", scan.repo.id).maybeSingle();
    return { ok: true, scan, alreadyConnectedId: data?.id ?? null };
  } catch (e) {
    return { ok: false, error: msg(e) };
  }
}

/**
 * Step 3 — Add game. Re-scans on the server instead of trusting data posted by the browser,
 * so a game record can only exist if GitHub returned the repository just now.
 */
export async function addGameAction(input: {
  installationId: number;
  owner: string;
  repo: string;
  name: string;
  type: GameType;
  devStatus: DevStatus;
}): Promise<ActionResult<{ id: string }>> {
  try {
    const { supabase } = await requireUser();
    const id = await addGame(supabase, input);
    revalidatePath("/", "layout");
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: msg(e) };
  }
}

/** Re-scan one connected game. Keeps old data and records the error if GitHub fails. */
export async function refreshGameAction(gameId: string): Promise<ActionResult> {
  try {
    const { supabase } = await requireUser();
    await refreshGame(supabase, gameId);
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (e) {
    revalidatePath("/", "layout");
    return { ok: false, error: msg(e) };
  }
}

export async function updateGameAction(input: {
  id: string;
  name: string;
  type: GameType;
  devStatus: DevStatus;
  pmRef: string;
}): Promise<ActionResult> {
  try {
    const { supabase } = await requireUser();
    const name = input.name.trim();
    if (!name || name.length > 120) throw new Error("Enter a game name (max 120 characters).");
    if (input.type !== "mini" && input.type !== "premium") throw new Error("Invalid type");
    if (!DEV_STATUSES.includes(input.devStatus)) throw new Error("Invalid status");
    const { error } = await supabase
      .from("games")
      .update({ name, game_type: input.type, dev_status: input.devStatus, pm_ref: input.pmRef.trim() || null })
      .eq("id", input.id);
    if (error) throw new Error(error.message);
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: msg(e) };
  }
}

/** Removes the portal record only. The GitHub repository is never touched. */
export async function removeGameAction(gameId: string, typedName: string): Promise<ActionResult> {
  try {
    const { supabase } = await requireUser();
    const game = await getGame(supabase, gameId);
    if (!game) throw new Error("Game not found");
    if (typedName.trim() !== game.name) throw new Error("Type the game name exactly to confirm.");
    const { error } = await supabase.from("games").delete().eq("id", gameId);
    if (error) throw new Error(error.message);
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: msg(e) };
  }
}
