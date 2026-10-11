import type { Metadata } from "next";
import Link from "next/link";
import { RunBadge } from "@/components/StatusBadges";
import { TriggerButton } from "@/components/TriggerButton";
import { triggerDisabledReason } from "@/lib/workflow-trigger";
import { Badge, EmptyState, PageHeader, timeAgo } from "@/components/ui";
import { listGames, listWorkflows } from "@/lib/games";
import { listReleases } from "@/lib/releases";
import { runState } from "@/lib/status";
import { MigrationNotice } from "@/components/MigrationNotice";
import { phase2Ready } from "@/lib/phase2";
import { requireUser } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Releases" };

const KINDS = ["test", "build", "publish"] as const;
const STATES = ["failing", "running", "passing"] as const;

export default async function ReleasesPage({ searchParams }: { searchParams: Promise<{ kind?: string; state?: string }> }) {
  const { kind = "", state = "" } = await searchParams;
  const { supabase } = await requireUser();
  const ready = await phase2Ready(supabase);
  const [games, workflows, releases, dispatches] = await Promise.all([
    listGames(supabase),
    listWorkflows(supabase),
    ready ? listReleases(supabase, { limit: 30 }) : Promise.resolve([]),
    supabase.from("workflow_dispatches").select("*").order("created_at", { ascending: false }).limit(8),
  ]);
  const gameById = new Map(games.map((g) => [g.id, g]));

  const rows = workflows
    .filter((w) => (!kind || w.kinds.includes(kind as (typeof KINDS)[number])) && (!state || runState(w) === state))
    .map((w) => ({ w, g: gameById.get(w.game_id)! }))
    .filter((r) => r.g)
    .sort((a, b) => Date.parse(b.w.run_updated_at ?? "0") - Date.parse(a.w.run_updated_at ?? "0"));

  const chip = (label: string, params: Record<string, string>, active: boolean) => (
    <Link key={label} href={{ pathname: "/releases", query: params }} className={`btn ${active ? "!bg-surface-2" : ""}`} aria-current={active ? "true" : undefined}>{label}</Link>
  );

  return (
    <>
      {!ready && <MigrationNotice what="Release candidates" />}
      <PageHeader title="Releases" subtitle="Real GitHub Actions status from each game’s default branch. Refresh a game to update it." />

      {workflows.length === 0 ? (
        <EmptyState title="No workflows found">
          {games.length === 0 ? <>Connect a game first.</> : <>None of your connected games has files in <code>.github/workflows</code>. The portal never creates workflows for you.</>}
        </EmptyState>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap gap-2">
            {chip("All", {}, !kind && !state)}
            {KINDS.map((k) => chip(k[0].toUpperCase() + k.slice(1), { kind: k }, kind === k))}
            {STATES.map((s) => chip(s[0].toUpperCase() + s.slice(1), { state: s }, state === s))}
          </div>

          {rows.length === 0 ? <EmptyState title="Nothing matches this filter" /> : (
            <ul className="card divide-y divide-line">
              {rows.map(({ w, g }) => (
                <li key={w.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      <Link href={`/games/${g.id}`} className="hover:underline">{g.name}</Link>
                      <span className="text-muted"> · {w.name}</span>
                    </p>
                    <p className="truncate text-xs text-muted">{w.kinds.length ? w.kinds.join(" + ") : "unclassified"}{w.platforms.length ? ` · ${w.platforms.join(", ")}` : ""} · {w.path}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="text-right text-xs text-muted">
                      <RunBadge w={w} />
                      {w.run_url ? <a href={w.run_url} target="_blank" rel="noreferrer" className="mt-1 block hover:underline">#{w.run_number} · {timeAgo(w.run_updated_at)}</a> : null}
                    </div>
{w.ci_ref ? <Link href={`/games/${g.id}`} className="btn">Open builds</Link> : (
                      <TriggerButton workflowRowId={w.id} workflowName={w.name} gameName={g.name} branch={g.default_branch} isPublish={w.kinds.includes("publish")} disabledReason={triggerDisabledReason(w, g.is_archived)} />
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <section className="mt-8" aria-labelledby="cand-h">
        <h2 id="cand-h" className="mb-2 text-sm font-semibold">Release candidates <span className="font-normal text-muted">· approval is manual; nothing is published from the portal</span></h2>
        {releases.length === 0 ? <p className="text-sm text-muted">None recorded. Record one from a successful build on a game page.</p> : (
          <ul className="card divide-y divide-line text-sm">
            {releases.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                <span className="min-w-0 truncate"><Link href={`/games/${r.game_id}`} className="font-medium hover:underline">{gameById.get(r.game_id)?.name ?? "Game"}</Link> <span className="text-muted">· {r.platform === "android" ? "Android" : "iOS"} v{r.version} ({r.build_number})</span></span>
                <span className="flex items-center gap-2 text-xs text-muted">{timeAgo(r.created_at)}<Badge tone={r.status === "approved" || r.status === "published_manually" ? "good" : r.status === "rejected" ? "muted" : "info"}>{{ candidate: "Candidate", approved: "Approved", rejected: "Rejected", published_manually: "Published manually" }[r.status]}</Badge></span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-8" aria-labelledby="audit-h">
        <h2 id="audit-h" className="mb-2 text-sm font-semibold">Recent manual triggers</h2>
        {(dispatches.data ?? []).length === 0 ? <p className="text-sm text-muted">None yet.</p> : (
          <ul className="card divide-y divide-line text-sm">
            {(dispatches.data ?? []).map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                <span className="min-w-0 truncate">{d.game_name} · <span className="text-muted">{d.workflow_path}</span></span>
                <span className="flex items-center gap-2 text-xs text-muted">
                  {d.user_email} · {timeAgo(d.created_at)}
                  <Badge tone={d.outcome === "accepted" ? "good" : "bad"} title={d.detail ?? undefined}>{d.outcome}</Badge>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
