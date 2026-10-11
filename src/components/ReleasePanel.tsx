import type { AdsConfig } from "@/lib/ads/config";
import { evaluateAndroid, evaluateIos, type Check, type Readiness } from "@/lib/ci/readiness";
import { CI_ACTION_META, isCiAction } from "@/lib/ci/actions";
import type { BuildRunRow, GameRow, ReleaseRow } from "@/lib/types";
import { Badge, timeAgo } from "./ui";
import { CandidateCreator, ReleaseActions } from "./ReleaseActions";

const MARK: Record<Check["state"], { icon: string; cls: string; label: string }> = {
  pass: { icon: "✓", cls: "text-[var(--good-fg)]", label: "pass" },
  fail: { icon: "✕", cls: "text-[var(--bad-fg)]", label: "fail" },
  warn: { icon: "!", cls: "text-[var(--warn-fg)]", label: "warning" },
  unknown: { icon: "?", cls: "text-muted", label: "unknown" },
};
const STATUS_TONE = { candidate: "info", approved: "good", rejected: "muted", published_manually: "good" } as const;
const STATUS_LABEL = { candidate: "Candidate", approved: "Approved", rejected: "Rejected", published_manually: "Published manually" } as const;

function Checks({ title, r }: { title: string; r: Readiness }) {
  return (
    <div>
      <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted">
        {title}
        <Badge tone={r.blockers ? "bad" : r.unknowns || r.warnings ? "warn" : "good"}>{r.blockers ? `${r.blockers} blocking` : r.unknowns || r.warnings ? "no blockers" : "ready"}</Badge>
      </h3>
      <ul className="flex flex-col gap-1.5 text-sm">
        {r.checks.map((c) => (
          <li key={c.id} className="grid grid-cols-[1.25rem_1fr] gap-1">
            <span className={`font-bold ${MARK[c.state].cls}`} aria-label={MARK[c.state].label}>{MARK[c.state].icon}</span>
            <span><span>{c.label}</span><span className="block text-xs text-muted">{c.detail}</span></span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ReleasePanel({ game, runs, releases, ads }: { game: GameRow; runs: BuildRunRow[]; releases: ReleaseRow[]; ads: AdsConfig | null }) {
  const hasCi = runs.length > 0;
  const android = evaluateAndroid(game, runs, releases, undefined, ads);
  const ios = evaluateIos(game, runs, releases, undefined, ads);
  const options = (actions: string[]) =>
    runs.filter((r) => r.action && actions.includes(r.action) && r.status === "completed" && r.conclusion === "success")
      .slice(0, 10).map((r) => ({ id: r.id, label: `${isCiAction(r.action) ? CI_ACTION_META[r.action].label : r.action} · ${r.head_sha?.slice(0, 7)} · v${r.version ?? "?"}${r.build_number !== null ? ` (${r.build_number})` : ""} · ${timeAgo(r.started_at)}` }));

  return (
    <section className="card mt-4" aria-labelledby="rel-h">
      <h2 id="rel-h" className="border-b border-line px-4 py-3 text-sm font-semibold">Release readiness <span className="font-normal text-muted">· manual approval only; nothing is ever published from here</span></h2>
      <div className="grid gap-6 p-4 lg:grid-cols-2">
        <Checks title="Android" r={android} />
        <Checks title="iOS" r={ios} />
      </div>
      {!hasCi && <p className="border-t border-line px-4 py-3 text-xs text-muted">No CI runs are recorded for this game, so build- and test-based checks are “unknown”.</p>}

      <div className="border-t border-line px-4 py-3">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Release candidates</h3>
        <div className="mb-3 grid gap-2 sm:grid-cols-2">
          <CandidateCreator gameId={game.id} platform="android" runs={options(["android-release", "android-dev"])} />
          <CandidateCreator gameId={game.id} platform="ios" runs={options(["ios-validate"])} />
        </div>
        {releases.length === 0 ? <p className="text-sm text-muted">No candidates recorded.</p> : (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {releases.map((rel) => (
              <li key={rel.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                <span className="min-w-0">
                  <strong>{rel.platform === "android" ? "Android" : "iOS"} v{rel.version} ({rel.build_number})</strong>
                  <span className="block text-xs text-muted">
                    <span className="font-mono">{rel.head_sha?.slice(0, 7)}</span> · {timeAgo(rel.created_at)} · {rel.readiness.blockers} blocking check(s) when recorded
                    {rel.decided_by_email && <> · {rel.status} by {rel.decided_by_email}</>}
                    {rel.artifact_id !== null && <> · <a className="underline" href={`/api/artifacts/${game.id}/${rel.artifact_id}`}>download {rel.artifact_name}</a></>}
                  </span>
                </span>
                <span className="flex items-center gap-2"><Badge tone={STATUS_TONE[rel.status]}>{STATUS_LABEL[rel.status]}</Badge><ReleaseActions release={rel} gameName={game.name} /></span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
