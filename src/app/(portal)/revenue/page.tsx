import type { Metadata } from "next";
import { Badge, PageHeader } from "@/components/ui";
import { listGames } from "@/lib/games";
import { revenueProviders } from "@/lib/revenue/providers";
import { monetizationSummary } from "@/lib/status";
import { requireUser } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Revenue" };

export default async function RevenuePage() {
  const { supabase } = await requireUser();
  const [games, connections] = await Promise.all([listGames(supabase), Promise.all(revenueProviders.map(async (p) => ({ p, c: await p.connection() })))]);
  const anyConnected = connections.some(({ c }) => c.state === "connected");

  return (
    <>
      <PageHeader title="Revenue" subtitle="No figures are shown until a reporting source is connected. Nothing on this page is estimated." />

      <div className="grid gap-4 sm:grid-cols-2">
        {connections.map(({ p, c }) => (
          <section key={p.id} className="card p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">{p.label}</h2>
              <Badge tone={c.state === "connected" ? "good" : "muted"}>{c.state === "connected" ? "Connected" : "Not connected"}</Badge>
            </div>
            <p className="mt-2 text-sm text-muted">{c.state === "connected" ? `Account: ${c.accountLabel}` : c.reason}</p>
            <p className="mt-1 text-xs text-muted">Interface: <code>RevenueProvider</code> in <code>src/lib/revenue</code></p>
          </section>
        ))}
      </div>

      <section className="card mt-4" aria-labelledby="per-game-h">
        <h2 id="per-game-h" className="border-b border-line px-4 py-3 text-sm font-semibold">Per game</h2>
        {games.length === 0 ? <p className="px-4 py-8 text-center text-sm text-muted">No games connected.</p> : (
          <ul className="divide-y divide-line">
            {games.map((g) => {
              const m = monetizationSummary(g);
              return (
                <li key={g.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
                  <span className="font-medium">{g.name}</span>
                  <span className="flex items-center gap-3 text-xs text-muted">
                    <span>{m.state === "detected" ? `${m.items.join(" + ")} in project` : "No monetization SDK detected"}</span>
                    <Badge tone="muted">{anyConnected ? "No data" : "Not connected"}</Badge>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}
