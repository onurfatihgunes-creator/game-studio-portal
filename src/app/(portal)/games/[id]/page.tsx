import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { GameActions } from "@/components/GameActions";
import { MonetizationBadge } from "@/components/StatusBadges";
import { Badge, PageHeader, timeAgo } from "@/components/ui";
import { getGame } from "@/lib/games";
import { masterGamePm } from "@/lib/integrations/master-pm";
import { monetizationSummary } from "@/lib/status";
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

      <section className="card" aria-labelledby="repo-h">
        <h2 id="repo-h" className="border-b border-line px-4 py-3 text-sm font-semibold">Repository</h2>
        <dl className="divide-y divide-line">
          <Row label="Latest commit">
            {game.commit_sha ? <a href={game.commit_url ?? game.html_url} target="_blank" rel="noreferrer" className="hover:underline"><span className="font-mono text-xs">{game.commit_sha.slice(0, 7)}</span> {game.commit_message}<span className="block text-xs text-muted">{game.commit_author} · {timeAgo(game.commit_at)}</span></a> : <Badge tone="muted">Empty repository</Badge>}
          </Row>
          <Row label="Default branch"><code>{game.default_branch}</code></Row>
          <Row label="Unity">{game.unity_detected ? <>{game.unity_version ?? "version unreadable"}{game.unity_project_path ? <span className="block text-xs text-muted">in {game.unity_project_path}</span> : null}{game.unity_note && <span className="block text-xs text-muted">{game.unity_note}</span>}</> : <Badge tone="warn">Not detected</Badge>}</Row>
          <Row label="Advertising"><MonetizationBadge m={monetizationSummary(game)} /> <Link href={`/games/${game.id}/ads`} className="ml-2 text-xs underline">AdMob IDs</Link></Row>
          <Row label="Last synced">{timeAgo(game.last_synced_at)}</Row>
          <Row label="Connected">{new Date(game.connected_at).toLocaleDateString()}</Row>
        </dl>
      </section>
      <p className="mt-6 text-sm"><Link href="/games" className="text-muted hover:underline">← All games</Link></p>
    </>
  );
}
