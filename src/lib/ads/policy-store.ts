import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { type AdsPolicy, DEFAULT_POLICY, normalizePolicy, samePolicy, toRemoteJson } from "./policy";

type Db = SupabaseClient;
export const POLICY_BUCKET = "ads-policy";
export const POLICY_OBJECT = "policy.json";

export type StoredPolicy = { policy: AdsPolicy; version: number; publishedAt: string | null };

/** Public URL games fetch (no key, no credential). Null when Supabase is not configured. */
export function policyPublicUrl(base = process.env.NEXT_PUBLIC_SUPABASE_URL): string | null {
  const root = base?.trim().replace(/\/$/, "");
  return root ? `${root}/storage/v1/object/public/${POLICY_BUCKET}/${POLICY_OBJECT}` : null;
}

export async function getStoredPolicy(db: Db): Promise<StoredPolicy> {
  const { data, error } = await db.from("ads_policy").select("*").eq("id", 1).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return { policy: DEFAULT_POLICY, version: 0, publishedAt: null };
  return { policy: normalizePolicy(data.policy as Partial<AdsPolicy>), version: Number(data.version ?? 0), publishedAt: (data.published_at as string | null) ?? null };
}

export type PublishResult = {
  version: number;
  url: string;
  /** What actually happened: nothing to do / new version written. */
  changed: boolean;
  /** The public URL was fetched back and carries this version. false = not verified (reason in `note`). */
  verified: boolean;
  note: string | null;
};

type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** GET the public file back, the way a game would. */
export async function verifyPublished(url: string, version: number, fetcher: Fetcher = (u) => fetch(u, { cache: "no-store" })): Promise<{ ok: boolean; note: string | null }> {
  try {
    const res = await fetcher(`${url}?v=${version}`);
    if (!res.ok) return { ok: false, note: `Public URL answered HTTP ${res.status}.` };
    const body = JSON.parse(await res.text()) as { schema?: number; policyVersion?: number };
    if (body.schema !== 1) return { ok: false, note: "Public file has an unexpected schema." };
    if (body.policyVersion !== version) return { ok: false, note: `Public file still shows policy v${body.policyVersion}; the CDN may take a minute to refresh.` };
    return { ok: true, note: null };
  } catch (e) {
    return { ok: false, note: e instanceof Error ? e.message : "Could not read the public URL." };
  }
}

/**
 * Saves the policy and publishes it for games. Idempotent: an unchanged policy keeps its version and is only re-verified.
 * The upload runs as the signed-in member (storage RLS); no service key exists in this app.
 */
export async function publishPolicy(db: Db, input: Partial<AdsPolicy>, email: string | null, deps: { fetcher?: Fetcher; now?: () => Date } = {}): Promise<PublishResult> {
  const url = policyPublicUrl();
  if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set, so there is no public URL for the policy file.");
  const policy = normalizePolicy(input);
  const current = await getStoredPolicy(db);
  const changed = current.version === 0 || !samePolicy(current.policy, policy);
  const version = changed ? current.version + 1 : current.version;
  const publishedAt = (deps.now?.() ?? new Date()).toISOString();

  if (changed) {
    const body = JSON.stringify(toRemoteJson(policy, version, publishedAt), null, 2);
    const { error: upErr } = await db.storage.from(POLICY_BUCKET).upload(POLICY_OBJECT, new Blob([body], { type: "application/json" }), { upsert: true, contentType: "application/json", cacheControl: "60" });
    if (upErr) throw new Error(`Publishing the policy file failed: ${upErr.message}. Has supabase/migrations/0003_ads_apply_all.sql been run?`);
    const { error } = await db.from("ads_policy").upsert({ id: 1, policy, version, published_at: publishedAt, updated_at: publishedAt, updated_by_email: email }, { onConflict: "id" });
    if (error) throw new Error(error.message);
  }
  const v = await verifyPublished(url, version, deps.fetcher);
  return { version, url, changed, verified: v.ok, note: v.note };
}
