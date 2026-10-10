import { NextResponse, type NextRequest } from "next/server";
import { apiGuard, errorMessage } from "@/lib/api";
import { refreshGame } from "@/lib/game-sync";

/** Refresh one game; the Games page calls this a few at a time for "Refresh all". */
export async function POST(request: NextRequest) {
  const g = await apiGuard(request);
  if ("error" in g) return g.error;
  try {
    const { id } = (await request.json()) as { id?: string };
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Invalid game id");
    await refreshGame(g.supabase, id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: errorMessage(e) }, { status: 400 });
  }
}
