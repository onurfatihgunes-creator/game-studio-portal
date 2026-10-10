import Link from "next/link";
import { AggregateBadge } from "@/components/StatusBadges";
import { EmptyState, PageHeader, Stat, timeAgo } from "@/components/ui";
import { readGitHubConfig } from "@/lib/github/app";
import { groupWorkflows, listGames, listWorkflows } from "@/lib/games";
import { gameSummary, runState } from "@/lib/status";
import { requireUser } from "@/lib/supabase/server";
import { DEV_STATUSES, DEV_STATUS_LABEL } from "@/lib/types";

export default async function OverviewPage() {
  const { supabase } = await requireUser();
  const [games, workflows] = await Promise.all([listGames(supabase), listWorkflows(supabase)]);
  const byGame = groupWorkflows(workflows);
  const summaries = games.map((g) => ({ g, s: gameSummary(g, byGame.get(g.id) ?? []) }));

  const failing = workflows.filter((w) => runState(w) === "failing");
  const running = workflows.filter((w) => runState(w) === "running");
  const gameName = (id: string) => games.find((g) => g.id === id)?.name ?? "";
  const count = (f: (x: (typeof summaries)[number]) => boolean) => summaries.filter(f).length;
  const github = readGitHubConfig();

  if (games.length === 0) {
    return (
      <>
        <PageHeader title="Overview" />
        <EmptyState title="Welcome — no games connected yet">
          {github.ok ? "Connect your first Unity game from GitHub. It takes three steps." : "GitHub is not configured on the server yet. Follow the README setup, then connect a game."}
          <div className="mt-4"><Link href="/games/new" className="btn btn-primary">Connect a game</Link></div>
        </EmptyState>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Overview" subtitle="Computed from data synced from GitHub. Use Refresh on Games to update it." actions={<Link href="/games/new" className="btn btn-primary">Connect game</Link>} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Games" value={games.length} hint={`${count(({ g }) => g.unity_detected)} with Unity detected`} />
        <Stat label="Failing workflows" value={failing.length} hint="Latest run on default branch" />
        <Stat label="Running now" value={running.length} />
        <Stat label="Tests configured" value={count(({ s }) => s.tests !== "not_configured")} hint={`of ${games.length} games`} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <section className="card" aria-labelledby="attn-h">
          <h2 id="attn-h" className="border-b border-line px-4 py-3 text-sm font-semibold">Needs attention</h2>
          {failing.length === 0 ? <p className="px-4 py-6 text-sm text-muted">No failing workflows.</p> : (
            <ul className="divide-y divide-line">
              {failing.slice(0, 8).map((w) => (
                <li key={w.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                  <Link href={`/games/${w.game_id}`} className="min-w-0 truncate hover:underline">{gameName(w.game_id)} <span className="text-muted">· {w.name}</span></Link>
                  <span className="shrink-0 text-xs text-muted">{timeAgo(w.run_updated_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card" aria-labelledby="dev-h">
          <h2 id="dev-h" className="border-b border-line px-4 py-3 text-sm font-semibold">By development status</h2>
          <ul className="divide-y divide-line">
            {DEV_STATUSES.map((st) => (
              <li key={st} className="flex items-center justify-between px-4 py-2.5 text-sm"><span>{DEV_STATUS_LABEL[st]}</span><span className="tabular-nums text-muted">{games.filter((g) => g.dev_status === st).length}</span></li>
            ))}
          </ul>
        </section>

        <section className="card" aria-labelledby="cap-h">
          <h2 id="cap-h" className="border-b border-line px-4 py-3 text-sm font-semibold">Pipeline coverage</h2>
          <ul className="divide-y divide-line text-sm">
            {([["Test workflow", (s: ReturnType<typeof gameSummary>) => s.tests], ["Build workflow", (s: ReturnType<typeof gameSummary>) => s.build], ["Android build", (s: ReturnType<typeof gameSummary>) => s.android], ["iOS build", (s: ReturnType<typeof gameSummary>) => s.ios], ["Publishing workflow", (s: ReturnType<typeof gameSummary>) => s.publishing]] as const).map(([label, pick]) => (
              <li key={label} className="flex items-center justify-between px-4 py-2.5"><span>{label}</span><span className="text-muted tabular-nums">{summaries.filter(({ s }) => pick(s) !== "not_configured").length} / {games.length} configured</span></li>
            ))}
          </ul>
        </section>

        <section className="card" aria-labelledby="recent-h">
          <h2 id="recent-h" className="border-b border-line px-4 py-3 text-sm font-semibold">Recently pushed</h2>
          <ul className="divide-y divide-line">
            {[...games].sort((a, b) => Date.parse(b.commit_at ?? "0") - Date.parse(a.commit_at ?? "0")).slice(0, 6).map((g) => (
              <li key={g.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                <Link href={`/games/${g.id}`} className="min-w-0 truncate hover:underline">{g.name}<span className="block truncate text-xs text-muted">{g.commit_message ?? "No commits"}</span></Link>
                <span className="flex shrink-0 items-center gap-2 text-xs text-muted">{timeAgo(g.commit_at)}<AggregateBadge value={gameSummary(g, byGame.get(g.id) ?? []).build} /></span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}
