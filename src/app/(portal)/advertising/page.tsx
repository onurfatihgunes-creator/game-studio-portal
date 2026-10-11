import type { Metadata } from "next";
import { MigrationNotice } from "@/components/MigrationNotice";
import { PageHeader } from "@/components/ui";
import { listApplyResults } from "@/lib/ads/apply";
import type { ApplyStatus } from "@/lib/ads/apply-types";
import { writeAccess } from "@/lib/ads/apply-run";
import { normalizeConfig } from "@/lib/ads/config";
import { ownIdPlatforms } from "@/lib/ads/integration";
import { getStoredPolicy, policyPublicUrl } from "@/lib/ads/policy-store";
import { listAdsConfigs } from "@/lib/ads/store";
import { listGames } from "@/lib/games";
import { MIGRATION_ADS, MIGRATION_APPLY, schemaState } from "@/lib/schema";
import { requireUser } from "@/lib/supabase/server";
import { AdvertisingClient, type GameRowView } from "./AdvertisingClient";

export const metadata: Metadata = { title: "Advertising" };

export default async function AdvertisingPage() {
  const { supabase } = await requireUser();
  const schema = await schemaState(supabase);
  const header = <PageHeader title="Advertising" subtitle="Configure advertising once and apply it to every connected Unity game." />;
  if (!schema.ads) return <>{header}<MigrationNotice what="Advertising" file={MIGRATION_ADS} /></>;
  if (!schema.apply) return <>{header}<MigrationNotice what="Apply to All Games" file={MIGRATION_APPLY} /></>;

  const [games, configs, results, stored] = await Promise.all([listGames(supabase), listAdsConfigs(supabase), listApplyResults(supabase), getStoredPolicy(supabase)]);
  const cfgOf = new Map(configs.map((c) => [c.game_id, normalizeConfig(c)]));
  const resultOf = new Map(results.map((r) => [r.game_id, r]));
  const canWrite = games.length ? await writeAccess(games[0].github_installation_id) : null;

  const rows: GameRowView[] = games.map((g) => {
    const hasIds = ownIdPlatforms(cfgOf.get(g.id)).length > 0;
    const r = resultOf.get(g.id);
    const stale = hasIds && r?.status === "needs_ids";            // IDs were saved after the last Apply
    const status: ApplyStatus | "not_applied" = !g.unity_detected ? "needs_integration" : !hasIds ? "needs_ids" : stale ? "not_applied" : (r?.status ?? "not_applied");
    const detail = !g.unity_detected ? "No Unity project was detected in this repository."
      : !hasIds ? (r?.status === "needs_ids" ? (r.detail ?? "") : "No AdMob app ID and ad units of its own are saved for this game yet. Apply still prepares a safe, disabled integration.")
      : stale ? "AdMob IDs are saved. Press Apply to put them into the pull request."
      : (r?.detail ?? "Not applied yet.");
    return { id: g.id, name: g.name, fullName: g.full_name, unity: g.unity_detected, status, detail, prUrl: r?.pr_url ?? null, prNumber: r?.pr_number ?? null, moduleVersion: r?.module_version ?? g.monetization?.studio_ads?.module_version ?? null, hooks: r?.hooks ?? null, checkedAt: r?.updated_at ?? null };
  });

  return (
    <>
      {header}
      <AdvertisingClient
        initialPolicy={stored.policy}
        published={{ version: stored.version, at: stored.publishedAt, url: policyPublicUrl() }}
        rows={rows}
        canWrite={canWrite}
      />
    </>
  );
}
