import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { adsStatus, emptyConfig, normalizeConfig } from "@/lib/ads/config";
import { getAdsConfig } from "@/lib/ads/store";
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
  return (
    <>
      <PageHeader title={`${game.name} · Advertising`} subtitle="The portal stores and validates this; the Unity module (com.studio.ads) executes it. AdMob apps and ad units are created in AdMob, not here." />
      <AdsForm gameId={game.id} gameName={game.name} initial={cfg} saved={!!row} status={adsStatus(row ? cfg : null)} androidId={game.project_facts?.androidBundleId ?? null} iosId={game.project_facts?.iosBundleId ?? null} />
      <p className="mt-6 text-sm"><Link href={`/games/${game.id}`} className="text-muted hover:underline">← {game.name}</Link></p>
    </>
  );
}
