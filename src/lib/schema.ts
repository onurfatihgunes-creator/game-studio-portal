import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

export const MIGRATION_ADS = "supabase/migrations/0002_phase2_ci_releases_ads.sql";
export const MIGRATION_APPLY = "supabase/migrations/0003_ads_apply_all.sql";

/** PostgREST/Postgres codes for "table/column does not exist (yet)". */
export function isMissingSchemaError(e: { code?: string; message?: string } | null | undefined): boolean {
  return !!e && (e.code === "42P01" || e.code === "42703" || e.code === "PGRST205" || e.code === "PGRST204" || /schema cache/i.test(e.message ?? ""));
}

async function tableExists(db: SupabaseClient, table: string): Promise<boolean> {
  const { error } = await db.from(table).select("*", { head: true, count: "exact" }).limit(1);
  return !isMissingSchemaError(error);
}

/** Which optional tables are in the database. Cheap head queries, safe on every render. */
export async function schemaState(db: SupabaseClient): Promise<{ ads: boolean; apply: boolean }> {
  const [ads, apply] = await Promise.all([tableExists(db, "game_ads_config"), tableExists(db, "ads_policy")]);
  return { ads, apply: ads && apply };
}

/** Friendly wording for write failures caused by an un-applied migration. */
export function schemaHint(message: string): string {
  if (/ads_policy|ads_apply_result/i.test(message)) return `The database is missing the Apply-to-all tables. Run ${MIGRATION_APPLY} in the Supabase SQL Editor, then try again. (${message})`;
  return /schema cache|project_facts|game_ads_config|revenue_daily|admob_connection/i.test(message)
    ? `The database is missing a table or column. Run ${MIGRATION_ADS} in the Supabase SQL Editor, then try again. (${message})`
    : message;
}
