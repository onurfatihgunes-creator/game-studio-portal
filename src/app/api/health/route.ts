import { NextResponse } from "next/server";
import { getInstallationToken, listInstallations, readGitHubConfig } from "@/lib/github/app";
import { createClient } from "@/lib/supabase/server";

/** Authenticated connection check: Supabase session + DB read, and GitHub App credentials. Never returns secrets. */
export async function GET() {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

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
  return NextResponse.json(result);
}
