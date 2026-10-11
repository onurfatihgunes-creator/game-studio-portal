import { NextResponse, type NextRequest } from "next/server";
import { getInstallationToken, ghRedirectLocation } from "@/lib/github/app";
import { requireGitHubConfig } from "@/lib/github/config";
import { getGame, listBuildRuns } from "@/lib/games";
import { createClient } from "@/lib/supabase/server";

/**
 * Authenticated artifact download. The browser never sees GitHub credentials: the server asks GitHub for the
 * artifact's short-lived signed URL and redirects to it. Only artifacts the portal has recorded for THIS game
 * are served (the GitHub App can see every repo, so ids from the URL are never trusted on their own).
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ gameId: string; artifactId: string }> }) {
  const { gameId, artifactId } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(gameId) || !/^\d{1,15}$/.test(artifactId)) return new NextResponse("Bad request", { status: 400 });

  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return new NextResponse("Unauthorized", { status: 401 });

  const game = await getGame(supabase, gameId);
  if (!game) return new NextResponse("Not found", { status: 404 });
  const runs = await listBuildRuns(supabase, { gameId });
  const known = runs.some((r) => r.artifacts.some((a) => String(a.id) === artifactId && !a.expired));
  if (!known) return new NextResponse("Artifact not found or expired", { status: 404 });

  try {
    const token = await getInstallationToken(requireGitHubConfig(), game.github_installation_id);
    const loc = await ghRedirectLocation(token, `/repos/${encodeURIComponent(game.owner)}/${encodeURIComponent(game.repo)}/actions/artifacts/${artifactId}/zip`);
    if (!loc) return new NextResponse("Artifact expired on GitHub", { status: 410 });
    const res = NextResponse.redirect(loc, 302);
    res.headers.set("Cache-Control", "no-store");
    res.headers.set("Referrer-Policy", "no-referrer");
    return res;
  } catch (e) {
    return new NextResponse(e instanceof Error ? e.message : "Download failed", { status: 502 });
  }
}
