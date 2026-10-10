import { NextResponse, type NextRequest } from "next/server";
import { apiGuard, errorMessage } from "@/lib/api";
import { addGame, classifyImportError } from "@/lib/game-sync";

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
      requireUnity: true, // bulk import only adds confirmed Unity projects
    });
    return NextResponse.json({ ok: true, id });
  } catch (e) {
    const kind = classifyImportError(e);
    const status = kind === "duplicate" ? 409 : kind === "rejected" ? 422 : 400;
    return NextResponse.json({ ok: false, error: errorMessage(e), code: kind }, { status });
  }
}
