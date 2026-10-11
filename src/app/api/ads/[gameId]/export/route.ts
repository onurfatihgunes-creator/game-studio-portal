import { NextResponse, type NextRequest } from "next/server";
import { exportForUnity, normalizeConfig, validateConfig } from "@/lib/ads/config";
import { getAdsConfig } from "@/lib/ads/store";
import { getGame } from "@/lib/games";
import { createClient } from "@/lib/supabase/server";

/** Authenticated download of the Unity config file (Resources/StudioAdsConfig.json). Refuses invalid configurations. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ gameId: string }> }) {
  const { gameId } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(gameId)) return new NextResponse("Bad request", { status: 400 });
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return new NextResponse("Unauthorized", { status: 401 });
  const game = await getGame(supabase, gameId);
  const row = game ? await getAdsConfig(supabase, gameId) : null;
  if (!game || !row) return new NextResponse("No advertising configuration for this game", { status: 404 });
  const cfg = normalizeConfig(row);
  const errors = validateConfig(cfg).filter((p) => p.level === "error");
  if (errors.length) return new NextResponse(`Configuration is invalid: ${errors[0].message}`, { status: 422 });
  return new NextResponse(JSON.stringify(exportForUnity(cfg), null, 2), {
    headers: { "Content-Type": "application/json", "Content-Disposition": 'attachment; filename="StudioAdsConfig.json"', "Cache-Control": "no-store" },
  });
}
