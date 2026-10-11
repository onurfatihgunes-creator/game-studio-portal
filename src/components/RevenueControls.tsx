"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";

async function post(url: string, body: unknown = {}) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return (await res.json()) as { ok: boolean; error?: string; result?: { rows: number; gamesWithData: number; unmatched: { appId: string; appName: string | null }[]; truncated: boolean; currency: string | null } };
}

export function AdMobControls({ connected }: { connected: boolean }) {
  const router = useRouter();
  const dlg = useRef<HTMLDialogElement>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [unmatched, setUnmatched] = useState<{ appId: string; appName: string | null }[]>([]);
  const [pending, start] = useTransition();
  if (!connected) return <a className="btn btn-primary" href="/api/integrations/admob/connect">Connect AdMob</a>;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn" disabled={pending} onClick={() => start(async () => {
          const r = await post("/api/integrations/admob/sync");
          if (!r.ok || !r.result) return setMsg({ ok: false, text: r.error ?? "Sync failed" });
          setUnmatched(r.result.unmatched);
          setMsg({ ok: true, text: `Synced ${r.result.rows} report rows for ${r.result.gamesWithData} game(s)${r.result.truncated ? " (report truncated by AdMob)" : ""}.` });
          router.refresh();
        })}>{pending ? "Syncing…" : "Sync now"}</button>
        <button className="btn btn-danger" onClick={() => dlg.current?.showModal()}>Disconnect</button>
        {msg && <span role="status" className={`text-sm ${msg.ok ? "text-muted" : "text-[var(--bad-fg)]"}`}>{msg.text}</span>}
      </div>
      {unmatched.length > 0 && (
        <p className="mt-2 text-xs text-muted">AdMob reported {unmatched.length} app(s) not matched to any game (set the production AdMob app ID on the game): {unmatched.map((u) => u.appName ?? u.appId).join(", ")}</p>
      )}
      <dialog ref={dlg} className="m-auto w-[min(92vw,26rem)] rounded-xl border border-line bg-surface p-5 text-fg backdrop:bg-black/50">
        <h2 className="text-base font-semibold">Disconnect AdMob?</h2>
        <p className="mt-2 text-sm text-muted">The authorization is revoked at Google and deleted here. Revenue already synced stays in the portal.</p>
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn" onClick={() => dlg.current?.close()}>Cancel</button>
          <button className="btn btn-danger" disabled={pending} onClick={() => start(async () => { const r = await post("/api/integrations/admob/disconnect"); dlg.current?.close(); if (!r.ok) setMsg({ ok: false, text: r.error ?? "Failed" }); router.refresh(); })}>Disconnect</button>
        </div>
      </dialog>
    </>
  );
}
