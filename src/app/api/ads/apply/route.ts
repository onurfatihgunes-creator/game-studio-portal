import { NextResponse, type NextRequest } from "next/server";
import { applyOneGame, prepareApply } from "@/lib/ads/apply-run";
import { apiGuard, errorMessage } from "@/lib/api";

export const maxDuration = 60;

/**
 * "Apply to All Games", driven by the Advertising page one step at a time (a route handler, not a Server Action, so several games
 * can run in parallel and no single request approaches a time limit).
 *   { step: "prepare", policy }  → saves + publishes the shared policy
 *   { step: "game", gameId }     → inspects ONE game's repository and prepares/updates its pull request if needed
 */
export async function POST(request: NextRequest) {
  const g = await apiGuard(request);
  if ("error" in g) return g.error;
  try {
    const body = (await request.json()) as { step?: string; policy?: unknown; gameId?: unknown };
    if (body.step === "prepare") {
      const { data } = await g.supabase.auth.getUser();
      const published = await prepareApply(g.supabase, (body.policy ?? {}) as object, data.user?.email ?? null);
      return NextResponse.json({ ok: true, published });
    }
    if (body.step === "game") {
      if (typeof body.gameId !== "string" || !/^[0-9a-f-]{36}$/i.test(body.gameId)) throw new Error("Invalid game id");
      return NextResponse.json({ ok: true, result: await applyOneGame(g.supabase, body.gameId) });
    }
    throw new Error("Unknown step");
  } catch (e) {
    return NextResponse.json({ ok: false, error: errorMessage(e) }, { status: 400 });
  }
}
