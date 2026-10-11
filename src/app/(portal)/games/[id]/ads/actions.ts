"use server";

import { revalidatePath } from "next/cache";
import type { AdsConfig, Problem } from "@/lib/ads/config";
import { applyTestDefaults, saveAdsConfig } from "@/lib/ads/store";
import { listGames } from "@/lib/games";
import { requireUser } from "@/lib/supabase/server";
import type { ActionResult } from "../../actions";

const msg = (e: unknown) => (e instanceof Error ? e.message : "Unexpected error");
const UUID = /^[0-9a-f-]{36}$/i;

export async function saveAdsAction(gameId: string, config: Partial<AdsConfig>): Promise<ActionResult<{ problems: Problem[] }>> {
  try {
    const { supabase, user } = await requireUser();
    if (!UUID.test(gameId)) throw new Error("Invalid game");
    const { problems } = await saveAdsConfig(supabase, gameId, config, user.email ?? null);
    revalidatePath("/", "layout");
    return { ok: true, problems };
  } catch (e) {
    return { ok: false, error: msg(e) };
  }
}

/** Batch: safe test defaults (disabled, test mode, Google demo IDs) for every game that has no configuration yet. Never overwrites. */
export async function applyTestDefaultsAction(): Promise<ActionResult<{ created: number }>> {
  try {
    const { supabase, user } = await requireUser();
    const games = await listGames(supabase);
    const created = await applyTestDefaults(supabase, games.map((g) => g.id), user.email ?? null);
    revalidatePath("/", "layout");
    return { ok: true, created };
  } catch (e) {
    return { ok: false, error: msg(e) };
  }
}
