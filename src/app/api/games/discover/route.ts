import { NextResponse, type NextRequest } from "next/server";
import { apiGuard, errorMessage } from "@/lib/api";
import { parseRepoRef } from "@/lib/game-sync";
import { requireGitHubConfig } from "@/lib/github/config";
import { quickUnityCheck } from "@/lib/github/scan";

const MAX_BATCH = 20;

/** Read-only: for each repo, is there a Unity project at the root? One GitHub call per repo. */
export async function POST(request: NextRequest) {
  const g = await apiGuard(request);
  if ("error" in g) return g.error;
  try {
    const body = (await request.json()) as { repos?: { installationId: number; owner: string; repo: string }[] };
    const repos = body.repos ?? [];
    if (!Array.isArray(repos) || repos.length === 0 || repos.length > MAX_BATCH) throw new Error(`Send 1–${MAX_BATCH} repositories`);
    const cfg = requireGitHubConfig();
    const results = await Promise.all(
      repos.map(async (r) => {
        try {
          const ref = parseRepoRef(r.installationId, r.owner, r.repo);
          return { owner: ref.owner, repo: ref.repo, unity: await quickUnityCheck(cfg, ref.id, ref.owner, ref.repo) };
        } catch (e) {
          return { owner: r.owner, repo: r.repo, unity: null, error: errorMessage(e) };
        }
      }),
    );
    return NextResponse.json({ ok: true, results });
  } catch (e) {
    return NextResponse.json({ ok: false, error: errorMessage(e) }, { status: 400 });
  }
}
