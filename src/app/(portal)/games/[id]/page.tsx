import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { GameActions } from "@/components/GameActions";
import { AggregateBadge, MonetizationBadge, RunBadge } from "@/components/StatusBadges";
import { TriggerButton } from "@/components/TriggerButton";
import { triggerDisabledReason } from "@/lib/workflow-trigger";
import { Badge, PageHeader, timeAgo } from "@/components/ui";
import { getGame, listBuildRuns, listWorkflows } from "@/lib/games";
import { listReleases } from "@/lib/releases";
import { MigrationNotice } from "@/components/MigrationNotice";
import { phase2Ready } from "@/lib/phase2";
import { getAdsConfig } from "@/lib/ads/store";
import { adsStatus } from "@/lib/ads/config";
import { BuildsPanel } from "@/components/BuildsPanel";
import { ReleasePanel } from "@/components/ReleasePanel";
import { masterGamePm } from "@/lib/integrations/master-pm";
import { gameSummary } from "@/lib/status";
import { requireUser } from "@/lib/supabase/server";
import { DEV_STATUS_LABEL, GAME_TYPE_LABEL } from "@/lib/types";

export const metadata: Metadata = { title: "Game" };

const uuid = /^[0-9a-f-]{36}$/i;

export default async function GamePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!uuid.test(id)) notFound();
  const { supabase } = await requireUser();
  const game = await getGame(supabase, id);
  if (!game) notFound();
  const ready = await phase2Ready(supabase);
  const [workflows, runs, releases, ads] = await Promise.all([listWorkflows(supabase, id), ready ? listBuildRuns(supabase, { gameId: id, limit: 50 }) : Promise.resolve([]), ready ? listReleases(supabase, { gameId: id }) : Promise.resolve([]), ready ? getAdsConfig(supabase, id) : Promise.resolve(null)]);
  const s = gameSummary(game, workflows);
  const pmLink = masterGamePm.linkFor(game);

  const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div className="flex items-center justify-between gap-3 px-4 py-3 text-sm"><dt className="text-muted">{label}</dt><dd className="min-w-0 text-right">{children}</dd></div>
  );

  return (
    <>
      <PageHeader
        title={game.name}
        subtitle={<><a href={game.html_url} target="_blank" rel="noreferrer" className="hover:underline">{game.full_name}</a> · {GAME_TYPE_LABEL[game.game_type]} · {DEV_STATUS_LABEL[game.dev_status]}{pmLink && <> · <a href={pmLink} target="_blank" rel="noreferrer" className="underline">Master Game PM</a></>}</>}
        actions={<GameActions game={game} pmEnabled={!!process.env.MASTER_PM_BASE_URL} />}
      />

      {game.last_sync_error && (
        <p role="alert" className="mb-4 rounded-lg bg-[var(--bad-bg)] p-3 text-sm text-[var(--bad-fg)]">Last refresh failed: {game.last_sync_error}. Showing data from {timeAgo(game.last_synced_at)}.</p>
      )}
      {game.is_archived && <p className="mb-4 rounded-lg bg-[var(--warn-bg)] p-3 text-sm text-[var(--warn-fg)]">This repository is archived on GitHub.</p>}

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card" aria-labelledby="status-h">
          <h2 id="status-h" className="border-b border-line px-4 py-3 text-sm font-semibold">Status</h2>
          <dl className="divide-y divide-line">
            <Row label="Tests"><AggregateBadge value={s.tests} /></Row>
            <Row label="Build"><AggregateBadge value={s.build} /></Row>
            <Row label="Android build"><AggregateBadge value={s.android} title="Latest run of a build workflow that targets Android. This is NOT release readiness: see “Release readiness” below." /></Row>
            <Row label="iOS build"><AggregateBadge value={s.ios} title="Latest run of a build workflow that targets iOS. This is NOT release readiness: see “Release readiness” below." /></Row>
            <Row label="Monetization"><MonetizationBadge m={s.monetization} /></Row>
            <Row label="Advertising"><Link href={`/games/${game.id}/ads`} className="hover:underline"><Badge tone={{ not_configured: "muted", disabled: "muted", test: "warn", invalid: "bad", production_ready: "good" }[adsStatus(ads)] as "muted"}>{{ not_configured: "Not configured", disabled: "Disabled", test: "Test mode", invalid: "Invalid config", production_ready: "Production IDs set" }[adsStatus(ads)]}</Badge></Link></Row>
            <Row label="Publishing"><AggregateBadge value={s.publishing} title={s.publishing === "not_configured" ? "No publishing workflow found" : "Latest run of the detected publishing workflow"} /></Row>
          </dl>
        </section>

        <section className="card" aria-labelledby="repo-h">
          <h2 id="repo-h" className="border-b border-line px-4 py-3 text-sm font-semibold">Repository</h2>
          <dl className="divide-y divide-line">
            <Row label="Latest commit">
              {game.commit_sha ? <a href={game.commit_url ?? game.html_url} target="_blank" rel="noreferrer" className="hover:underline"><span className="font-mono text-xs">{game.commit_sha.slice(0, 7)}</span> {game.commit_message}<span className="block text-xs text-muted">{game.commit_author} · {timeAgo(game.commit_at)}</span></a> : <Badge tone="muted">Empty repository</Badge>}
            </Row>
            <Row label="Default branch"><code>{game.default_branch}</code></Row>
            <Row label="Unity">{game.unity_detected ? <>{game.unity_version ?? "version unreadable"}{game.unity_project_path ? <span className="block text-xs text-muted">in {game.unity_project_path}</span> : null}{game.unity_note && <span className="block text-xs text-muted">{game.unity_note}</span>}</> : <Badge tone="warn">Not detected</Badge>}</Row>
            <Row label="Documentation">{game.docs.length ? <span className="text-xs">{game.docs.map((d) => d.path).slice(0, 8).join(", ")}{game.docs.length > 8 ? ` +${game.docs.length - 8}` : ""}</span> : <Badge tone="muted">Not configured</Badge>}</Row>
            <Row label="Last synced">{timeAgo(game.last_synced_at)}</Row>
            <Row label="Connected">{new Date(game.connected_at).toLocaleDateString()}</Row>
          </dl>
        </section>
      </div>

      {ready ? (
        <>
          <BuildsPanel game={game} workflows={workflows} runs={runs} />
          <ReleasePanel game={game} runs={runs} releases={releases} ads={ads} />
        </>
      ) : <div className="mt-4"><MigrationNotice what="Builds, release readiness and advertising" /></div>}

      <section className="card mt-4" aria-labelledby="wf-h">
        <h2 id="wf-h" className="border-b border-line px-4 py-3 text-sm font-semibold">Workflows <span className="font-normal text-muted">· latest run on {game.default_branch}</span></h2>
        {workflows.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted">Not configured — no files in <code>.github/workflows</code>.</p>
        ) : (
          <ul className="divide-y divide-line">
            {workflows.map((w) => (
              <li key={w.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{w.name}</p>
                  <p className="truncate text-xs text-muted" title={w.signals.join("; ")}>
                    {w.path} · {w.kinds.length ? w.kinds.join(" + ") : "unclassified"}{w.platforms.length ? ` · ${w.platforms.join(", ")}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <div className="text-right text-xs text-muted">
                    <RunBadge w={w} />
                    {w.run_url && <a href={w.run_url} target="_blank" rel="noreferrer" className="mt-1 block hover:underline">#{w.run_number} · {timeAgo(w.run_updated_at)}</a>}
                  </div>
                  {w.ci_ref ? <span className="text-xs text-muted">Use “Builds & tests” above</span> : (
                    <TriggerButton workflowRowId={w.id} workflowName={w.name} gameName={game.name} branch={game.default_branch} isPublish={w.kinds.includes("publish")} disabledReason={triggerDisabledReason(w, game.is_archived)} />
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <p className="mt-6 text-sm"><Link href="/games" className="text-muted hover:underline">← All games</Link></p>
    </>
  );
}
