"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import type { RepoSummary } from "@/lib/github/app";
import type { ScanResult } from "@/lib/github/types";
import { DEV_STATUSES, DEV_STATUS_LABEL, type DevStatus, type GameType } from "@/lib/types";
import { Badge } from "@/components/ui";
import { addGameAction, scanRepoAction } from "../actions";

const Step = ({ n, title, active, done }: { n: number; title: string; active: boolean; done: boolean }) => (
  <li className={`flex items-center gap-2 text-sm ${active ? "font-semibold" : done ? "text-fg" : "text-muted"}`}>
    <span className={`flex h-6 w-6 items-center justify-center rounded-full border text-xs ${done ? "border-transparent bg-accent text-accent-fg" : active ? "border-accent text-accent" : "border-line"}`}>{done ? "✓" : n}</span>
    {title}
  </li>
);

const prettify = (repo: string) => repo.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export function ConnectWizard({ repos, connected, installUrl }: { repos: RepoSummary[]; connected: Record<number, string>; installUrl: string | null }) {
  const router = useRouter();
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<RepoSummary | null>(null);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, startScan] = useTransition();
  const [adding, startAdd] = useTransition();
  const [name, setName] = useState("");
  const [type, setType] = useState<GameType>("mini");
  const [devStatus, setDevStatus] = useState<DevStatus>("in_development");

  const visible = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return repos.filter((r) => !f || r.fullName.toLowerCase().includes(f)).slice(0, 100);
  }, [repos, filter]);

  const step = scan ? 3 : selected ? 2 : 1;

  function choose(r: RepoSummary) {
    setSelected(r);
    setScan(null);
    setError(null);
    setName(prettify(r.name));
  }

  function runScan() {
    if (!selected) return;
    setError(null);
    startScan(async () => {
      const res = await scanRepoAction(selected.installationId, selected.owner, selected.name);
      if (!res.ok) return setError(res.error);
      if (res.alreadyConnectedId) return router.push(`/games/${res.alreadyConnectedId}`);
      setScan(res.scan);
    });
  }

  function add() {
    if (!selected) return;
    setError(null);
    startAdd(async () => {
      const res = await addGameAction({ installationId: selected.installationId, owner: selected.owner, repo: selected.name, name, type, devStatus });
      if (!res.ok) return setError(res.error);
      router.push(`/games/${res.id}`);
      router.refresh();
    });
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
      <ol className="flex gap-4 lg:flex-col lg:gap-3">
        <Step n={1} title="Select repository" active={step === 1} done={step > 1} />
        <Step n={2} title="Scan project" active={step === 2} done={step > 2} />
        <Step n={3} title="Add game" active={step === 3} done={false} />
      </ol>

      <div className="card p-4 sm:p-5">
        {error && <p role="alert" className="mb-4 rounded-lg bg-[var(--bad-bg)] p-3 text-sm text-[var(--bad-fg)]">{error}</p>}

        {step === 1 && (
          <>
            <input className="input" placeholder={`Filter ${repos.length} repositories…`} value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter repositories" />
            <ul className="mt-3 max-h-[420px] divide-y divide-line overflow-y-auto rounded-lg border border-line">
              {visible.map((r) => {
                const existing = connected[r.id];
                return (
                  <li key={r.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{r.fullName}</p>
                      <p className="truncate text-xs text-muted">{r.private ? "Private" : "Public"}{r.archived ? " · Archived" : ""}{r.description ? ` · ${r.description}` : ""}</p>
                    </div>
                    {existing ? (
                      <Link href={`/games/${existing}`} className="btn shrink-0">Connected</Link>
                    ) : (
                      <button className="btn shrink-0" onClick={() => choose(r)}>Select</button>
                    )}
                  </li>
                );
              })}
              {visible.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted">No repositories match.</li>}
            </ul>
            {installUrl && <p className="mt-3 text-xs text-muted">Repository missing? <a className="underline" href={installUrl} target="_blank" rel="noreferrer">Grant the GitHub App access to more repositories</a>, then reload.</p>}
          </>
        )}

        {step === 2 && selected && (
          <>
            <p className="text-sm text-muted">Selected</p>
            <p className="mb-4 font-medium">{selected.fullName}</p>
            <p className="mb-4 text-sm text-muted">The scan reads repository metadata, the latest commit, the Unity version, documentation, <code>.github/workflows</code> and their latest runs. It writes nothing.</p>
            <div className="flex gap-2">
              <button className="btn btn-primary" onClick={runScan} disabled={scanning}>{scanning ? "Scanning…" : "Scan project"}</button>
              <button className="btn" onClick={() => setSelected(null)} disabled={scanning}>Change</button>
            </div>
          </>
        )}

        {step === 3 && selected && scan && (
          <>
            <ScanSummary scan={scan} />
            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              <label className="text-sm font-medium sm:col-span-2">Game name
                <input className="input mt-1" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
              </label>
              <label className="text-sm font-medium">Type
                <select className="input mt-1" value={type} onChange={(e) => setType(e.target.value as GameType)}>
                  <option value="mini">Mini</option>
                  <option value="premium">Premium</option>
                </select>
              </label>
              <label className="text-sm font-medium">Development status
                <select className="input mt-1" value={devStatus} onChange={(e) => setDevStatus(e.target.value as DevStatus)}>
                  {DEV_STATUSES.map((s) => <option key={s} value={s}>{DEV_STATUS_LABEL[s]}</option>)}
                </select>
              </label>
            </div>
            <p className="mt-2 text-xs text-muted">Type and status can’t be detected from GitHub, so you set them. They can be changed later.</p>
            <div className="mt-4 flex gap-2">
              <button className="btn btn-primary" onClick={add} disabled={adding || !name.trim()}>{adding ? "Adding…" : "Add game"}</button>
              <button className="btn" onClick={() => setScan(null)} disabled={adding}>Back</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ScanSummary({ scan }: { scan: ScanResult }) {
  const by = (k: "test" | "build" | "publish") => scan.workflows.filter((w) => w.kinds.includes(k)).length;
  const rows: [string, React.ReactNode][] = [
    ["Repository", <>{scan.repo.fullName} · {scan.repo.isPrivate ? "private" : "public"} · default branch <code>{scan.repo.defaultBranch}</code></>],
    ["Latest commit", scan.latestCommit ? <>{scan.latestCommit.sha.slice(0, 7)} — {scan.latestCommit.message}</> : <Badge tone="muted">Empty repository</Badge>],
    ["Unity project", scan.unity.detected ? <>Unity {scan.unity.version ?? "(version unreadable)"}{scan.unity.projectPath ? <> in <code>{scan.unity.projectPath}</code></> : null}{scan.unity.note ? <span className="text-muted"> · {scan.unity.note}</span> : null}</> : <><Badge tone="warn">Not detected</Badge>{scan.unity.note && <span className="ml-2 text-muted">{scan.unity.note}</span>}</>],
    ["Documentation", scan.docs.length ? scan.docs.slice(0, 6).map((d) => d.path).join(", ") + (scan.docs.length > 6 ? ` +${scan.docs.length - 6} more` : "") : <Badge tone="muted">Not configured</Badge>],
    ["Workflows", scan.workflows.length ? `${scan.workflows.length} found · ${by("test")} test · ${by("build")} build · ${by("publish")} publish` : <Badge tone="muted">Not configured</Badge>],
    ["Monetization SDKs", !scan.monetization.checked ? <Badge tone="muted">Not configured</Badge> : [scan.monetization.admob && "AdMob", scan.monetization.iap && "Unity IAP", ...(scan.monetization.other_ads ?? [])].filter(Boolean).join(", ") || <Badge tone="muted">Not configured</Badge>],
  ];
  return (
    <>
      <p className="mb-3 flex items-center gap-2 text-sm font-medium"><Badge tone="good">GitHub responded</Badge> Scan complete</p>
      <dl className="divide-y divide-line rounded-lg border border-line text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="grid gap-1 px-3 py-2.5 sm:grid-cols-[160px_1fr]"><dt className="text-muted">{k}</dt><dd className="min-w-0 break-words">{v}</dd></div>
        ))}
      </dl>
    </>
  );
}
