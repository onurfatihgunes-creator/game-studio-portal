import { NextResponse, type NextRequest } from "next/server";
import { apiGuard, errorMessage } from "@/lib/api";
import { addGame } from "@/lib/game-sync";
import { DuplicateGameError } from "@/lib/games";

/** Add one game (called repeatedly, a few at a time, by the bulk import page). */
export async function POST(request: NextRequest) {
  const g = await apiGuard(request);
  if ("error" in g) return g.error;
  try {
    const body = await request.json();
    const id = await addGame(g.supabase, {
      installationId: body.installationId,
      owner: body.owner,
      repo: body.repo,
      name: body.name,
      type: body.type,
      devStatus: body.devStatus,
    });
    return NextResponse.json({ ok: true, id });
  } catch (e) {
    const duplicate = e instanceof DuplicateGameError;
    return NextResponse.json({ ok: false, error: errorMessage(e), code: duplicate ? "duplicate" : undefined }, { status: duplicate ? 409 : 400 });
  }
}
