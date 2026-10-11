import type { Metadata } from "next";
import Link from "next/link";
import { AdMobControls, AdsDefaultsButton } from "@/components/RevenueControls";
import { Badge, PageHeader, timeAgo } from "@/components/ui";
import { adsStatus, normalizeConfig, type AdsStatus } from "@/lib/ads/config";
import { listAdsConfigs } from "@/lib/ads/store";
import { listGames } from "@/lib/games";
import { ecpm, readAdMobEnv } from "@/lib/revenue/admob";
import { revenueProviders } from "@/lib/revenue/providers";
import { MigrationNotice } from "@/components/MigrationNotice";
import { phase2Ready } from "@/lib/phase2";
import { requireUser } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Revenue" };

const ADS_BADGE: Record<AdsStatus, { tone: "muted" | "warn" | "bad" | "good"; text: string }> = {
  not_configured: { tone: "muted", text: "Not configured" }, disabled: { tone: "muted", text: "Disabled" }, test: { tone: "warn", text: "Test mode" },
  invalid: { tone: "bad", text: "Invalid" }, production_ready: { tone: "good", text: "Production IDs" },
};
const ERRORS: Record<string, string> = {
  config: "AdMob sign-in is not configured on the server (see README → AdMob).", denied: "Google sign-in was cancelled.", state: "The sign-in could not be verified. Try again.",
  token: "Google did not return a usable authorization. Try again and accept all requested permissions.", scope: "Both read-only AdMob permissions are required. Try again and leave them ticked.",
  account: "No AdMob account was found for that Google user.",
};
const money = (micros: number, cur: string) => new Intl.NumberFormat("en", { style: "currency", currency: cur }).format(micros / 1e6);

export default async function RevenuePage({ searchParams }: { searchParams: Promise<{ admob?: string }> }) {
  const { admob } = await searchParams;
  const { supabase } = await requireUser();
  if (!(await phase2Ready(supabase))) return <><PageHeader title="Revenue" subtitle="Only real data from AdMob appears here. Nothing is estimated or filled in." /><MigrationNotice what="Revenue and advertising" /></>;
  const env = readAdMobEnv();
  const providers = revenueProviders(supabase, env.ok);
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const [games, configs, conns, daily, conn] = await Promise.all([
    listGames(supabase), listAdsConfigs(supabase), Promise.all(providers.map(async (p) => ({ p, c: await p.connection() }))),
    supabase.from("revenue_daily").select("game_id,day,currency,earnings_micros,impressions,clicks").gte("day", since),
    supabase.from("admob_connection").select("last_error,connected_by_email").eq("id", 1).maybeSingle(),
  ]);
  const cfgOf = new Map(configs.map((c) => [c.game_id, c]));
  const rows = daily.data ?? [];
  const admobConn = conns.find(({ p }) => p.id === "admob")!.c;
  const connected = admobConn.state === "connected";
  const currencies = new Set(rows.map((r) => String(r.currency)));
  const agg = new Map<string, { e: number; i: number; days: number; last: string }>();
  for (const r of rows) {
    const a = agg.get(r.game_id) ?? { e: 0, i: 0, days: 0, last: "" };
    a.e += Number(r.earnings_micros); a.i += Number(r.impressions); a.days++; a.last = a.last > r.day ? a.last : r.day;
    agg.set(r.game_id, a);
  }
  const single = currencies.size === 1 ? [...currencies][0] : null;
  const totalE = [...agg.values()].reduce((s, a) => s + a.e, 0), totalI = [...agg.values()].reduce((s, a) => s + a.i, 0);

  return (
    <>
      <PageHeader title="Revenue" subtitle="Only real data from AdMob appears here. Nothing is estimated or filled in." />
      {admob && <p role="status" className={`mb-4 rounded-lg p-3 text-sm ${admob === "connected" ? "bg-[var(--good-bg)] text-[var(--good-fg)]" : "bg-[var(--bad-bg)] text-[var(--bad-fg)]"}`}>{admob === "connected" ? "AdMob connected. Press “Sync now” to load revenue." : ERRORS[admob] ?? "AdMob connection failed."}</p>}

      <div className="grid gap-4 sm:grid-cols-2">
        {conns.map(({ p, c }) => (
          <section key={p.id} className="card p-4">
            <div className="flex items-center justify-between"><h2 className="text-sm font-semibold">{p.label}</h2><Badge tone={c.state === "connected" ? "good" : "muted"}>{c.state === "connected" ? "Connected" : "Not connected"}</Badge></div>
            <p className="mt-2 text-sm text-muted">{c.state === "connected" ? `Publisher ${c.accountLabel} · synced ${timeAgo(c.lastSyncedAt)}` : c.reason}</p>
            {p.id === "admob" && env.ok && <div className="mt-3"><AdMobControls connected={connected} /></div>}
            {p.id === "admob" && !env.ok && <p className="mt-2 text-xs text-muted">Missing server settings: <code>{env.missing.join(", ")}</code>. Setup steps are in the README (“AdMob revenue”).</p>}
            {p.id === "admob" && conn.data?.last_error && <p role="alert" className="mt-2 text-xs text-[var(--bad-fg)]">Last sync failed: {conn.data.last_error}</p>}
          </section>
        ))}
      </div>

      <section className="card mt-4" aria-labelledby="per-game-h">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
          <h2 id="per-game-h" className="text-sm font-semibold">Per game · last 30 days</h2>
          {connected && single && agg.size > 0 && <span className="text-sm text-muted">Total {money(totalE, single)} · {totalI.toLocaleString()} impressions{ecpm(totalE, totalI) !== null && ` · eCPM ${new Intl.NumberFormat("en", { style: "currency", currency: single }).format(ecpm(totalE, totalI)!)}`}</span>}
        </div>
        {games.length === 0 ? <p className="px-4 py-8 text-center text-sm text-muted">No games connected.</p> : (
          <ul className="divide-y divide-line">
            {games.map((g) => {
              const cfg = cfgOf.get(g.id);
              const st = adsStatus(cfg ? normalizeConfig(cfg) : null);
              const hasAppId = !!(cfg?.android?.app_id || cfg?.ios?.app_id);
              const a = agg.get(g.id);
              const cur = a && single ? single : null;
              return (
                <li key={g.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
                  <span className="min-w-0"><Link href={`/games/${g.id}`} className="font-medium hover:underline">{g.name}</Link> <Link href={`/games/${g.id}/ads`} className="ml-1"><Badge tone={ADS_BADGE[st].tone}>{ADS_BADGE[st].text}</Badge></Link></span>
                  <span className="text-xs text-muted">
                    {!connected ? <Badge tone="muted">Not connected</Badge>
                      : !hasAppId ? <Badge tone="muted" title="Set the AdMob app ID in the game's advertising settings">No AdMob app ID</Badge>
                      : !a ? <Badge tone="muted">No data yet</Badge>
                      : cur ? <span className="text-fg">{money(a.e, cur)} · {a.i.toLocaleString()} imp · eCPM {ecpm(a.e, a.i) === null ? "—" : new Intl.NumberFormat("en", { style: "currency", currency: cur }).format(ecpm(a.e, a.i)!)} · to {a.last}</span>
                      : <Badge tone="warn">Mixed currencies</Badge>}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <div className="border-t border-line px-4 py-3"><AdsDefaultsButton missing={games.filter((g) => !cfgOf.has(g.id)).length} /></div>
      </section>
    </>
  );
}
