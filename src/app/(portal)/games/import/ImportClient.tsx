"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui";
import type { RepoSummary } from "@/lib/github/app";
import { DEV_STATUSES, DEV_STATUS_LABEL, type DevStatus, type GameType } from "@/lib/types";

type Detect = "pending" | "yes" | "no" | "error";
type Phase = "idle" | "queued" | "importing" | "done" | "duplicate" | "rejected" | "error";
type Row = {
  repo: RepoSummary;
  detect: Detect;
  detectError?: string;
  selected: boolean;
  name: string;
  type: GameType;
  status: DevStatus;
  phase: Phase;
  error?: string;
  gameId?: string;
};

const IMPORT_CONCURRENCY = 4;
const DETECT_CONCURRENCY = 3;
const DETECT_BATCH = 10;

const prettify = (repo: string) => repo.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return (await res.json()) as T;
}

/** Runs `worker` over `items` with at most `limit` in flight. */
async function pool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await worker(item);
  }));
}

export function ImportClient({ repos, alreadyConnected }: { repos: RepoSummary[]; alreadyConnected: number }) {
  const [rows, setRows] = useState<Record<number, Row>>(() =>
    Object.fromEntries(repos.map((r) => [r.id, { repo: r, detect: "pending", selected: false, name: prettify(r.name), type: "mini", status: "in_development", phase: "idle" } satisfies Row])),
  );
  const [showAll, setShowAll] = useState(false);
  const [filter, setFilter] = useState("");
  const [importing, setImporting] = useState(false);
  const started = useRef(false);
  const rowsRef = useRef(rows);
  rowsRef.current = rows; // latest edits, read at send time

  const patch = useCallback((id: number, p: Partial<Row>) => setRows((cur) => ({ ...cur, [id]: { ...cur[id], ...p } })), []);

  // ── Discovery: read-only, batches of 10 repos, 3 batches in flight ──
  const detect = useCallback(async (list: RepoSummary[]) => {
    for (const r of list) patch(r.id, { detect: "pending", detectError: undefined });
    const batches: RepoSummary[][] = [];
    for (let i = 0; i < list.length; i += DETECT_BATCH) batches.push(list.slice(i, i + DETECT_BATCH));
    await pool(batches, DETECT_CONCURRENCY, async (batch) => {
      type Res = { ok: true; results: { owner: string; repo: string; unity: boolean | null; error?: string }[] } | { ok: false; error: string };
      const res = await post<Res>("/api/games/discover", { repos: batch.map((r) => ({ installationId: r.installationId, owner: r.owner, repo: r.name })) }).catch((e: Error) => ({ ok: false as const, error: e.message }));
      for (const r of batch) {
        if (!res.ok) { patch(r.id, { detect: "error", detectError: res.error }); continue; }
        const hit = res.results.find((x) => x.owner === r.owner && x.repo === r.name);
        if (!hit || hit.unity === null) patch(r.id, { detect: "error", detectError: hit?.error ?? "No result" });
        else patch(r.id, { detect: hit.unity ? "yes" : "no", detectError: undefined });
      }
    });
  }, [patch]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void detect(repos);
  }, [detect, repos]);

  const all = useMemo(() => Object.values(rows).sort((a, b) => a.repo.fullName.localeCompare(b.repo.fullName)), [rows]);
  const visible = all.filter((r) => {
    const f = filter.trim().toLowerCase();
    if (f && !r.repo.fullName.toLowerCase().includes(f) && !r.name.toLowerCase().includes(f)) return false;
    if (showAll) return true;
    return r.detect === "yes" || r.phase !== "idle"; // default: confirmed Unity repositories only
  });

  const checked = all.filter((r) => r.detect !== "pending").length;
  const detecting = checked < all.length; // derived from the rows, so the first render is already "loading"
  const unityCount = all.filter((r) => r.detect === "yes").length;
  const failedDetect = all.filter((r) => r.detect === "error");
  const selectedIds = all.filter((r) => r.selected && r.phase === "idle").map((r) => r.repo.id);
  const counts = {
    done: all.filter((r) => r.phase === "done").length,
    duplicate: all.filter((r) => r.phase === "duplicate").length,
    rejected: all.filter((r) => r.phase === "rejected").length,
    error: all.filter((r) => r.phase === "error").length,
    active: all.filter((r) => r.phase === "queued" || r.phase === "importing").length,
  };
  const editable = (r: Row) => !importing || r.phase === "idle" || r.phase === "error";
  const lockedRow = (r: Row) => r.phase === "done" || r.phase === "duplicate" || r.phase === "rejected" || r.phase === "importing" || r.phase === "queued";

  function setForSelected(p: Partial<Pick<Row, "type" | "status">>) {
    setRows((cur) => Object.fromEntries(Object.entries(cur).map(([k, r]) => [k, r.selected && !lockedRow(r) ? { ...r, ...p } : r])));
  }
  function selectVisible(on: boolean) {
    setRows((cur) => {
      const next = { ...cur };
      for (const r of visible) if (!lockedRow(r)) next[r.repo.id] = { ...next[r.repo.id], selected: on };
      return next;
    });
  }

  async function runImport(ids: number[]) {
    if (!ids.length) return;
    setImporting(true);
    for (const id of ids) patch(id, { phase: "queued", error: undefined });
    await pool(ids, IMPORT_CONCURRENCY, async (id) => {
      patch(id, { phase: "importing" });
      const row = rowsRef.current[id]; // values as edited when this row's turn came
      type Res = { ok: true; id: string } | { ok: false; error: string; code?: "duplicate" | "rejected" | "retryable" };
      const res = await post<Res>("/api/games/import", {
        installationId: row.repo.installationId, owner: row.repo.owner, repo: row.repo.name, name: row.name, type: row.type, devStatus: row.status,
      }).catch((e: Error): Res => ({ ok: false, error: e.message }));
      if (res.ok) patch(id, { phase: "done", gameId: res.id, selected: false });
      else if (res.code === "duplicate") patch(id, { phase: "duplicate", error: res.error, selected: false });
      else if (res.code === "rejected") patch(id, { phase: "rejected", error: res.error, selected: false });
      else patch(id, { phase: "error", error: res.error });
    });
    setImporting(false);
  }

  const retryFailed = () => void runImport(all.filter((r) => r.phase === "error").map((r) => r.repo.id));

  return (
    <div>
      <div className="card mb-4 p-4 text-sm" aria-live="polite">
        {detecting ? (
          <>
            <p className="font-medium">Checking {all.length} repositories for Unity projects…</p>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuemin={0} aria-valuemax={all.length} aria-valuenow={checked}>
              <div className="h-full bg-accent transition-all" style={{ width: `${(checked / Math.max(all.length, 1)) * 100}%` }} />
            </div>
            <p className="mt-1.5 text-xs text-muted">{checked} of {all.length} checked. Read-only; nothing is imported.</p>
          </>
        ) : (
          <>
            <p>
              <strong>{unityCount}</strong> confirmed Unity project{unityCount === 1 ? "" : "s"} found in {all.length} repositories.
              {alreadyConnected > 0 && <span className="text-muted"> {alreadyConnected} already connected (hidden).</span>}
            </p>
            <p className="mt-1 text-xs text-muted">A repository counts as a Unity game only if it has a <code>ProjectSettings</code> folder at its root. Other repositories (engines, tools, websites) stay hidden unless “Show all repositories” is on. Nothing is selected or imported until you choose.</p>
            {failedDetect.length > 0 && (
              <p className="mt-2 text-[var(--bad-fg)]">{failedDetect.length} repositor{failedDetect.length === 1 ? "y" : "ies"} could not be checked. <button className="underline" onClick={() => detect(failedDetect.map((r) => r.repo))}>Re-check</button></p>
            )}
          </>
        )}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input className="input max-w-xs" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter repositories" />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show all repositories</label>
        <span className="ml-auto flex gap-2">
          <button className="btn" onClick={() => selectVisible(true)} disabled={importing || detecting}>Select all</button>
          <button className="btn" onClick={() => selectVisible(false)} disabled={importing || detecting}>None</button>
        </span>
      </div>

      <div className="card mb-3 flex flex-wrap items-center gap-3 p-3 text-sm">
        <span className="text-muted">Apply to selected:</span>
        <select className="input w-auto" aria-label="Set type for selected" defaultValue="" onChange={(e) => { if (e.target.value) setForSelected({ type: e.target.value as GameType }); e.target.value = ""; }} disabled={importing || detecting}>
          <option value="">Type…</option><option value="mini">Mini</option><option value="premium">Premium</option>
        </select>
        <select className="input w-auto" aria-label="Set status for selected" defaultValue="" onChange={(e) => { if (e.target.value) setForSelected({ status: e.target.value as DevStatus }); e.target.value = ""; }} disabled={importing || detecting}>
          <option value="">Status…</option>{DEV_STATUSES.map((s) => <option key={s} value={s}>{DEV_STATUS_LABEL[s]}</option>)}
        </select>
      </div>

      {visible.length === 0 ? (
        detecting ? (
          <ul className="card divide-y divide-line" aria-hidden>
            {[0, 1, 2].map((i) => (
              <li key={i} className="flex animate-pulse items-center gap-3 px-3 py-4">
                <span className="h-4 w-4 rounded bg-surface-2" />
                <span className="h-4 flex-1 rounded bg-surface-2" />
                <span className="hidden h-8 w-28 rounded bg-surface-2 sm:block" />
              </li>
            ))}
          </ul>
        ) : (
          <p className="card px-4 py-10 text-center text-sm text-muted">No confirmed Unity game repositories to import. Turn on “Show all repositories” to look further.</p>
        )
      ) : (
        <ul className="card divide-y divide-line">
          {visible.map((r) => (
            <li key={r.repo.id} className="grid gap-2 px-3 py-3 sm:grid-cols-[auto_minmax(0,1fr)_minmax(0,1.2fr)_110px_150px] sm:items-center">
              <input type="checkbox" className="h-4 w-4" checked={r.selected} disabled={lockedRow(r)} onChange={(e) => patch(r.repo.id, { selected: e.target.checked })} aria-label={`Select ${r.repo.fullName}`} />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{r.repo.fullName}</p>
                <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                  {r.repo.private ? "Private" : "Public"}{r.repo.archived ? " · Archived" : ""}
                  {r.detect === "pending" && <Badge tone="muted">Checking…</Badge>}
                  {r.detect === "yes" && <Badge tone="good">Unity</Badge>}
                  {r.detect === "no" && <Badge tone="muted" title="No ProjectSettings folder at the repository root">Not detected</Badge>}
                  {r.detect === "error" && <Badge tone="bad" title={r.detectError}>Check failed</Badge>}
                </p>
              </div>
              <input className="input" value={r.name} maxLength={120} disabled={!editable(r) || lockedRow(r)} onChange={(e) => patch(r.repo.id, { name: e.target.value })} aria-label={`Name for ${r.repo.fullName}`} />
              <select className="input" value={r.type} disabled={!editable(r) || lockedRow(r)} onChange={(e) => patch(r.repo.id, { type: e.target.value as GameType })} aria-label="Type">
                <option value="mini">Mini</option><option value="premium">Premium</option>
              </select>
              <select className="input" value={r.status} disabled={!editable(r) || lockedRow(r)} onChange={(e) => patch(r.repo.id, { status: e.target.value as DevStatus })} aria-label="Status">
                {DEV_STATUSES.map((s) => <option key={s} value={s}>{DEV_STATUS_LABEL[s]}</option>)}
              </select>
              {r.phase !== "idle" && (
                <div className="text-xs sm:col-span-5 sm:pl-7" role="status">
                  {(r.phase === "queued" || r.phase === "importing") && <Badge tone="info">{r.phase === "queued" ? "Queued" : "Importing…"}</Badge>}
                  {r.phase === "done" && <><Badge tone="good">Added</Badge> <Link className="ml-2 underline" href={`/games/${r.gameId}`}>Open</Link></>}
                  {r.phase === "duplicate" && <Badge tone="warn">Already connected</Badge>}
                  {r.phase === "rejected" && <span className="text-muted"><Badge tone="warn">Not imported</Badge> <span className="ml-1">{r.error}</span></span>}
                  {r.phase === "error" && <span className="text-[var(--bad-fg)]"><Badge tone="bad">Failed</Badge> <span className="ml-1">{r.error}</span></span>}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="sticky bottom-16 z-[5] mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface p-3 md:bottom-4">
        <button className="btn btn-primary" onClick={() => runImport(selectedIds)} disabled={detecting || importing || selectedIds.length === 0}>
          {importing ? `Importing… ${counts.done + counts.duplicate + counts.rejected + counts.error}/${counts.done + counts.duplicate + counts.rejected + counts.error + counts.active}` : `Import ${selectedIds.length} selected`}
        </button>
        {counts.error > 0 && !importing && <button className="btn btn-primary" onClick={retryFailed}>Retry {counts.error} failed</button>}
        <span className="text-sm text-muted">
          {counts.done > 0 && `${counts.done} added`}{counts.duplicate > 0 && ` · ${counts.duplicate} already connected`}{counts.rejected > 0 && ` · ${counts.rejected} not imported`}{counts.error > 0 && ` · ${counts.error} failed`}
        </span>
        {counts.done > 0 && !importing && <Link href="/games" className="btn ml-auto">View games</Link>}
      </div>
    </div>
  );
}
