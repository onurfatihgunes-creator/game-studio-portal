import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

export const MIGRATION_FILE = "supabase/migrations/0002_phase2_ci_releases_ads.sql";

/** PostgREST/Postgres codes for "table/column does not exist (yet)". */
export function isMissingSchemaError(e: { code?: string; message?: string } | null | undefined): boolean {
  return !!e && (e.code === "42P01" || e.code === "42703" || e.code === "PGRST205" || e.code === "PGRST204" || /schema cache/i.test(e.message ?? ""));
}

/** True when the Phase 02 tables exist. A cheap head query, safe to call on every page render. */
export async function phase2Ready(db: SupabaseClient): Promise<boolean> {
  const { error } = await db.from("build_runs").select("id", { head: true, count: "exact" }).limit(1);
  return !isMissingSchemaError(error);
}

/** Friendly wording for write failures caused by an un-applied migration. */
export function schemaHint(message: string): string {
  return /schema cache|build_runs|project_facts|ci_ref|ci_actions|game_releases|game_ads_config|revenue_daily|admob_connection/i.test(message)
    ? `The database is missing the Phase 02 schema. Apply ${MIGRATION_FILE} in the Supabase SQL Editor, then try again. (${message})`
    : message;
}
