import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, PageHeader } from "@/components/ui";
import { adsStatus, emptyConfig, normalizeConfig } from "@/lib/ads/config";
import { getAdsConfig } from "@/lib/ads/store";
import { integrationChecklist, onboardCommand } from "@/lib/ads/integration";
import { getGame } from "@/lib/games";
import { MigrationNotice } from "@/components/MigrationNotice";
import { phase2Ready } from "@/lib/phase2";
import { requireUser } from "@/lib/supabase/server";
import { AdsForm } from "./AdsForm";

export const metadata: Metadata = { title: "Advertising" };

export default async function AdsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const { supabase } = await requireUser();
  const game = await getGame(supabase, id);
  if (!game) notFound();
  if (!(await phase2Ready(supabase))) return <><PageHeader title={`${game.name} · Advertising`} /><MigrationNotice what="Advertising configuration" /></>;
  const row = await getAdsConfig(supabase, id);
  const cfg = normalizeConfig(row ?? emptyConfig());
  const m = game.monetization;
  const checklist = integrationChecklist(
    { unity_detected: game.unity_detected, androidBundleId: game.project_facts?.androidBundleId ?? null, studioAds: m?.checked ? (m.studio_ads ?? null) : null, googlePlugin: m?.checked ? !!m.admob : null },
    row ? cfg : null,
  );
  const TONE = { ok: "good", todo: "bad", warn: "warn", unknown: "muted" } as const;
  const LABEL = { ok: "Done", todo: "Missing", warn: "Check", unknown: "Unknown" } as const;
  return (
    <>
      <PageHeader title={`${game.name} · Advertising`} subtitle="The portal stores and validates this; the Unity module (com.studio.ads) executes it. AdMob apps and ad units are created in AdMob, not here." />
      <section className="card mb-4 p-4">
        <h2 className="text-sm font-semibold">Integration checklist</h2>
        <ul className="mt-2 divide-y divide-line text-sm">
          {checklist.map((c) => (
            <li key={c.key} className="flex flex-wrap items-start justify-between gap-2 py-2">
              <span className="min-w-0"><span className="font-medium">{c.label}</span><span className="block text-xs text-muted">{c.detail}</span></span>
              <Badge tone={TONE[c.state]}>{LABEL[c.state]}</Badge>
            </li>
          ))}
        </ul>
        {checklist.some((c) => c.state === "todo" && ["module", "plugin", "file"].includes(c.key)) && (
          <div className="mt-3 text-xs">
            <p className="text-muted">Prepare the integration from the <code>unity-ci</code> repository on your Mac. It is a dry run until you add <code>--apply</code>, which opens a pull request on this game. Existing files and configs are never overwritten.</p>
            <pre className="mt-1 overflow-x-auto rounded bg-black/5 p-2 dark:bg-white/10">{onboardCommand(game.full_name, !(m?.admob))}</pre>
          </div>
        )}
        <p className="mt-3 text-xs text-muted">Each game needs its own AdMob app and ad units. The portal refuses an ID that another game already uses.</p>
      </section>
      <AdsForm gameId={game.id} gameName={game.name} initial={cfg} saved={!!row} status={adsStatus(row ? cfg : null)} androidId={game.project_facts?.androidBundleId ?? null} iosId={game.project_facts?.iosBundleId ?? null} />
      <p className="mt-6 text-sm"><Link href={`/games/${game.id}`} className="text-muted hover:underline">← {game.name}</Link></p>
    </>
  );
}
