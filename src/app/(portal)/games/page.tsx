import type { Metadata } from "next";
import Link from "next/link";
import { MonetizationBadge } from "@/components/StatusBadges";
import { RefreshAll } from "@/components/RefreshAll";
import { EmptyState, PageHeader, timeAgo } from "@/components/ui";
import { listGames } from "@/lib/games";
import { monetizationSummary } from "@/lib/status";
import { requireUser } from "@/lib/supabase/server";
import { DEV_STATUS_LABEL, GAME_TYPE_LABEL } from "@/lib/types";

export const metadata: Metadata = { title: "Games" };

export default async function GamesPage({ searchParams }: { searchParams: Promise<{ q?: string; type?: string }> }) {
  const { q = "", type = "" } = await searchParams;
  const { supabase } = await requireUser();
  const allGames = await listGames(supabase);

  const needle = q.trim().toLowerCase();
  const games = allGames.filter(
    (g) => (!needle || g.name.toLowerCase().includes(needle) || g.full_name.toLowerCase().includes(needle)) && (!type || g.game_type === type),
  );

  return (
    <>
      <PageHeader
        title="Games"
        subtitle={`${allGames.length} connected`}
        actions={
          <>
            <RefreshAll gameIds={allGames.map((g) => g.id)} />
            <Link href="/games/import" className="btn">Import many</Link>
            <Link href="/games/new" className="btn btn-primary">Connect game</Link>
          </>
        }
      />

      {allGames.length === 0 ? (
        <EmptyState title="No games connected yet">
          Connect an existing Unity game from GitHub in three steps: select the repository, scan it, add it.
          <div className="mt-4"><Link href="/games/new" className="btn btn-primary">Connect your first game</Link></div>
        </EmptyState>
      ) : (
        <>
          <form className="mb-4 flex flex-wrap gap-2" role="search">
            <input name="q" defaultValue={q} placeholder="Search games…" className="input max-w-xs" aria-label="Search games" />
            <select name="type" defaultValue={type} className="input w-auto" aria-label="Filter by type">
              <option value="">All types</option>
              <option value="mini">Mini</option>
              <option value="premium">Premium</option>
            </select>
            <button className="btn">Filter</button>
          </form>

          {games.length === 0 ? (
            <EmptyState title="No games match your filter" />
          ) : (
            <>
              {/* Desktop table */}
              <div className="card hidden overflow-x-auto md:block">
                <table className="w-full min-w-[720px] text-left text-sm">
                  <thead className="border-b border-line text-xs uppercase tracking-wide text-muted">
                    <tr>
                      {["Game", "Type", "Status", "Latest commit", "Ads"].map((h) => (
                        <th key={h} className="px-3 py-2.5 font-medium">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {games.map((g) => {
                      const m = monetizationSummary(g);
                      return (
                        <tr key={g.id} className="hover:bg-surface-2/60">
                          <td className="px-3 py-2.5">
                            <Link href={`/games/${g.id}`} className="font-medium hover:underline">{g.name}</Link>
                            <div className="text-xs text-muted">{g.full_name}</div>
                          </td>
                          <td className="px-3 py-2.5">{GAME_TYPE_LABEL[g.game_type]}</td>
                          <td className="px-3 py-2.5">{DEV_STATUS_LABEL[g.dev_status]}</td>
                          <td className="max-w-[220px] px-3 py-2.5">
                            {g.commit_sha ? (
                              <>
                                <div className="truncate" title={g.commit_message ?? ""}>{g.commit_message}</div>
                                <div className="text-xs text-muted">{g.commit_sha.slice(0, 7)} · {timeAgo(g.commit_at)}</div>
                              </>
                            ) : <span className="text-muted">—</span>}
                          </td>
                          <td className="px-3 py-2.5"><MonetizationBadge m={m} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Mobile cards */}
              <ul className="flex flex-col gap-3 md:hidden">
                {games.map((g) => {
                  const m = monetizationSummary(g);
                  return (
                    <li key={g.id} className="card p-4">
                      <Link href={`/games/${g.id}`} className="font-medium">{g.name}</Link>
                      <p className="text-xs text-muted">{g.full_name} · {GAME_TYPE_LABEL[g.game_type]} · {DEV_STATUS_LABEL[g.dev_status]}</p>
                      {g.commit_sha && <p className="mt-2 truncate text-sm">{g.commit_message}</p>}
                      <p className="mt-3 text-xs"><MonetizationBadge m={m} /></p>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </>
      )}
    </>
  );
}
