import { NextResponse, type NextRequest } from "next/server";
import { getInstallationToken, listInstallations, readGitHubConfig } from "@/lib/github/app";
import { deepChecks, exercise, type Step } from "@/lib/selftest";
import { createClient } from "@/lib/supabase/server";

export const maxDuration = 300;

const print = (title: string, steps: Step[]) => {
  console.log(`[selftest] ${title}`);
  for (const s of steps) console.log(`[selftest]  ${s.ok ? "PASS" : "FAIL"}  ${s.name} — ${s.detail}`);
  console.log(`[selftest] ${title}: ${steps.filter((s) => s.ok).length}/${steps.length} passed`);
};

/**
 * Authenticated connection check (never returns secrets).
 *   /api/health                      Supabase session + DB read, GitHub App credentials
 *   /api/health?deep=1               + schema state, configuration, and every page rendering with YOUR session
 *   /api/health?exercise=owner/repo  + end-to-end exercise (dev only; see lib/selftest.ts). Not available in production.
 * Results are also written to the server log with a [selftest] prefix.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const cookie = request.headers.get("cookie") ?? "";
  const origin = request.nextUrl.origin;

  const result: Record<string, unknown> = {};
  const { count, error } = await supabase.from("games").select("id", { count: "exact", head: true });
  result.supabase = error ? { ok: false, error: error.message } : { ok: true, games: count };

  const cfg = readGitHubConfig();
  if (!cfg.ok) {
    result.github = { ok: false, error: `missing ${cfg.missing.join(", ")}` };
  } else {
    try {
      const installs = await listInstallations(cfg.config);
      if (installs[0]) await getInstallationToken(cfg.config, installs[0].id);
      result.github = { ok: true, installations: installs.map((i) => i.account) };
    } catch (e) {
      result.github = { ok: false, error: e instanceof Error ? e.message : "failed" };
    }
  }

  const q = request.nextUrl.searchParams;
  if (q.get("deep")) { const s = await deepChecks(supabase, origin, cookie); result.deep = s; print("deep checks", s); }
  const repo = q.get("exercise");
  if (repo) {
    if (process.env.NODE_ENV === "production") result.exercise = [{ name: "exercise", ok: false, detail: "disabled in production" }];
    else if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) result.exercise = [{ name: "exercise", ok: false, detail: "use ?exercise=owner/repo" }];
    else { const s = await exercise(supabase, repo, origin, cookie, { id: auth.user.id, email: auth.user.email ?? null }); result.exercise = s; print(`exercise ${repo}`, s); }
  }
  return NextResponse.json(result);
}
