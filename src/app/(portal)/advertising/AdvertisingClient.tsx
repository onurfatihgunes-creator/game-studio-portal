"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge } from "@/components/ui";
import { type ApplyResult, type ApplyStatus, STATUS_LABEL, STATUS_TONE } from "@/lib/ads/apply-types";
import { type AdsPolicy, normalizePolicy } from "@/lib/ads/policy";

export type GameRowView = {
  id: string; name: string; fullName: string; unity: boolean;
  status: ApplyStatus | "not_applied"; detail: string; prUrl: string | null; prNumber: number | null;
  moduleVersion: string | null; hooks: boolean | null; checkedAt: string | null;
};
type Published = { version: number; at: string | null; url: string | null };
type PublishInfo = { version: number; url: string; changed: boolean; verified: boolean; note: string | null };

const Num = ({ label, value, onChange, min = 0, max }: { label: string; value: number; onChange: (n: number) => void; min?: number; max: number }) => (
  <label className="text-sm font-medium">{label}
    <input className="input mt-1" type="number" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} />
  </label>
);

export function AdvertisingClient({ initialPolicy, published, rows: initialRows, canWrite }: { initialPolicy: AdsPolicy; published: Published; rows: GameRowView[]; canWrite: boolean | null }) {
  const router = useRouter();
  const [policy, setPolicy] = useState<AdsPolicy>(initialPolicy);
  const [rows, setRows] = useState(initialRows);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pub, setPub] = useState<PublishInfo | null>(null);
  const [summary, setSummary] = useState<string | null>(null);

  const set = <K extends keyof AdsPolicy>(k: K, v: AdsPolicy[K]) => setPolicy((p) => ({ ...p, [k]: v }));
  const setI = (k: keyof AdsPolicy["interstitial"], v: number) => setPolicy((p) => ({ ...p, interstitial: { ...p.interstitial, [k]: v } }));

  async function post(body: unknown) {
    const res = await fetch("/api/ads/apply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return (await res.json().catch(() => ({ ok: false, error: "The server returned an unreadable response." }))) as { ok: boolean; error?: string; published?: PublishInfo; result?: ApplyResult };
  }

  async function applyAll() {
    setRunning(true); setError(null); setSummary(null); setPub(null);
    const prep = await post({ step: "prepare", policy: normalizePolicy(policy) });
    if (!prep.ok || !prep.published) { setRunning(false); setError(prep.error ?? "Could not publish the policy."); return; }
    setPub(prep.published);

    const queue = rows.filter((r) => r.unity).map((r) => r.id);
    const results: ApplyResult[] = [];
    setProgress({ done: 0, total: queue.length });
    const worker = async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        const r = await post({ step: "game", gameId: id });
        const res: ApplyResult | undefined = r.result;
        if (res) results.push(res);
        setRows((cur) => cur.map((row) => row.id === id
          ? res ? { ...row, status: res.status, detail: res.detail, prUrl: res.prUrl, prNumber: res.prNumber, moduleVersion: res.moduleVersion, hooks: res.hooks, checkedAt: new Date().toISOString() }
                : { ...row, status: "failed", detail: r.error ?? "Failed" }
          : row));
        setProgress((p) => (p ? { ...p, done: p.done + 1 } : p));
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, Math.max(1, queue.length)) }, worker));
    const n = (s: ApplyStatus) => results.filter((r) => r.status === s).length;
    const created = results.filter((r) => r.action === "created_pr").length, updated = results.filter((r) => r.action === "updated_pr").length;
    setSummary(`${results.length} game(s) checked · ${n("applied")} applied · ${n("pr_open")} awaiting approval · ${n("needs_ids")} need AdMob IDs · ${n("needs_integration")} need game integration · ${n("failed")} failed · pull requests created ${created}, updated ${updated}`);
    setRunning(false); setProgress(null);
    router.refresh();
  }

  const connected = rows.length;
  const unityCount = rows.filter((r) => r.unity).length;

  return (
    <div className="space-y-4">
      {canWrite === false && (
        <p role="alert" className="rounded-lg bg-[var(--warn-bg)] p-3 text-sm text-[var(--warn-fg)]">
          <strong>One-time GitHub step.</strong> The portal&apos;s GitHub App can read repositories but cannot create branches or pull requests yet. In GitHub: Settings ▸ Developer settings ▸ GitHub Apps ▸ your app ▸ Permissions ▸ set <em>Contents</em> and <em>Pull requests</em> to <em>Read &amp; write</em>, save, then accept the new permissions on the installation. Until then, Apply still checks every game but cannot prepare pull requests.
        </p>
      )}

      <section className="card p-4" aria-labelledby="policy-h">
        <h2 id="policy-h" className="text-sm font-semibold">Shared advertising policy</h2>
        <p className="mt-1 text-xs text-muted">One policy for every game. It is published as a small public file that integrated games fetch at runtime, so changes reach them <strong>without a rebuild</strong>. It never contains AdMob IDs and can never switch production ads on: production needs an approved pull request in each game.</p>

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <fieldset className="space-y-2">
            <legend className="text-xs font-semibold uppercase tracking-wide text-muted">General</legend>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={policy.enabled} onChange={(e) => set("enabled", e.target.checked)} /> Advertising enabled <span className="text-xs text-muted">(off by default)</span></label>
            <p className="text-sm">Test mode: <Badge tone="warn">always on here</Badge> <span className="text-xs text-muted">Google demo ads only</span></p>
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="text-xs font-semibold uppercase tracking-wide text-muted">Banner</legend>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={policy.banner_enabled} onChange={(e) => set("banner_enabled", e.target.checked)} /> Banner available</label>
            <label className="text-sm font-medium">Position
              <select className="input mt-1" value={policy.banner_position} onChange={(e) => set("banner_position", e.target.value === "top" ? "top" : "bottom")}><option value="bottom">Bottom</option><option value="top">Top</option></select>
            </label>
            <p className="text-xs text-muted">Which screens show it is decided by each game&apos;s own placement hooks.</p>
          </fieldset>

          <fieldset className="space-y-2 md:col-span-2">
            <legend className="text-xs font-semibold uppercase tracking-wide text-muted">Interstitial frequency</legend>
            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <Num label="At most once per N runs" value={policy.interstitial.every_n_runs} min={1} max={50} onChange={(n) => setI("every_n_runs", n)} />
              <Num label="Min seconds between" value={policy.interstitial.min_interval_s} max={3600} onChange={(n) => setI("min_interval_s", n)} />
              <Num label="Max per session" value={policy.interstitial.max_per_session} max={100} onChange={(n) => setI("max_per_session", n)} />
              <Num label="First delay (s)" value={policy.interstitial.first_delay_s} max={3600} onChange={(n) => setI("first_delay_s", n)} />
              <Num label="Runs before the first" value={policy.interstitial.min_runs_before_first} max={50} onChange={(n) => setI("min_runs_before_first", n)} />
            </div>
          </fieldset>

          <fieldset className="space-y-2 md:col-span-2">
            <legend className="text-xs font-semibold uppercase tracking-wide text-muted">Rewarded</legend>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={policy.rewarded_available} onChange={(e) => set("rewarded_available", e.target.checked)} /> Rewarded ads available <span className="text-xs text-muted">(a game must also define its own reward)</span></label>
            <div className="max-w-[12rem]"><Num label="Cooldown (s)" value={policy.rewarded_cooldown_s} max={3600} onChange={(n) => set("rewarded_cooldown_s", n)} /></div>
          </fieldset>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button className="btn btn-primary px-6 py-3 text-base" onClick={applyAll} disabled={running || connected === 0}>
            {running ? (progress ? `Applying… ${progress.done}/${progress.total}` : "Publishing policy…") : "Apply to All Games"}
          </button>
          <span className="text-xs text-muted">Publishes the policy, then checks {unityCount} Unity game{unityCount === 1 ? "" : "s"} and opens or updates a pull request only where one is needed. Nothing is merged. Safe to run again.</span>
        </div>
        {error && <p role="alert" className="mt-3 text-sm text-[var(--bad-fg)]">{error}</p>}
        {summary && <p role="status" className="mt-3 text-sm">{summary}</p>}
        <p className="mt-3 text-xs text-muted">
          Remote policy: {pub ? <>v{pub.version} {pub.changed ? "published now" : "unchanged"} · public file {pub.verified ? <Badge tone="good">reachable, version confirmed</Badge> : <Badge tone="warn">not confirmed</Badge>}{pub.note ? ` · ${pub.note}` : ""}</>
            : published.version > 0 ? <>v{published.version} published {published.at ? new Date(published.at).toLocaleString() : ""}</> : "not published yet"}
          {(pub?.url ?? published.url) && <> · <code className="break-all">{pub?.url ?? published.url}</code></>}
        </p>
      </section>

      <section className="card" aria-labelledby="games-h">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
          <h2 id="games-h" className="text-sm font-semibold">Games <span className="font-normal text-muted">· {connected} connected</span></h2>
          <div className="flex gap-2 text-sm"><Link href="/games/import" className="btn">Import games</Link><Link href="/games/ads-import" className="btn">Import AdMob IDs</Link></div>
        </div>
        {rows.length === 0 ? <p className="px-4 py-8 text-center text-sm text-muted">No games connected yet.</p> : (
          <ul className="divide-y divide-line">
            {rows.map((r) => (
              <li key={r.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 text-sm">
                <div className="min-w-0">
                  <Link href={`/games/${r.id}`} className="font-medium hover:underline">{r.name}</Link>
                  <span className="ml-2 text-xs text-muted">{r.fullName}</span>
                  <p className="mt-1 text-xs text-muted">{r.detail}</p>
                  {r.status !== "not_applied" && r.status !== "needs_ids" && r.unity && (
                    <p className="mt-1 text-xs text-muted">Module in default branch: {r.moduleVersion ?? "none"} · placement hooks: {r.hooks === null ? "unknown" : r.hooks ? "verified" : "not declared"}</p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {r.prUrl && <a href={r.prUrl} target="_blank" rel="noreferrer" className="text-xs underline">PR #{r.prNumber}</a>}
                  <Link href={`/games/${r.id}/ads`} className="text-xs underline">AdMob IDs</Link>
                  <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="border-t border-line px-4 py-3 text-xs text-muted">
          <strong>Applied</strong> means the integration is in the game&apos;s repository and its remote policy is set up. It does not mean a build with it has been released to players; that is not tracked here.
        </p>
      </section>
    </div>
  );
}
