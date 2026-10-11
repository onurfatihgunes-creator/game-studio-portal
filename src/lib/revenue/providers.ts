import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProviderConnection, RevenuePoint, RevenueProvider } from "./types";

/** In-app purchase reporting is not built yet: it honestly reports `not_connected` and never returns data. */
class NotConnectedProvider implements RevenueProvider {
  constructor(readonly id: RevenueProvider["id"], readonly label: string, private readonly reason: string) {}
  async connection(): Promise<ProviderConnection> { return { state: "not_connected", reason: this.reason }; }
  async fetchRevenue(): Promise<RevenuePoint[]> { throw new Error(`${this.label} is not connected`); }
}

/**
 * AdMob: connected only when an authorization is stored. `fetchRevenue` reads the portal's stored daily rows
 * (filled by syncAdMob); it never fabricates values.
 */
export class AdMobProvider implements RevenueProvider {
  readonly id = "admob" as const;
  readonly label = "Google AdMob";
  constructor(private readonly db: SupabaseClient, private readonly configured: boolean) {}

  async connection(): Promise<ProviderConnection> {
    if (!this.configured) return { state: "not_connected", reason: "The portal is not configured for Google sign-in yet (see the README: AdMob setup)." };
    const { data } = await this.db.from("admob_connection").select("publisher_id,last_synced_at,connected_at").eq("id", 1).maybeSingle();
    if (!data) return { state: "not_connected", reason: "No AdMob account has been authorized." };
    return { state: "connected", accountLabel: String(data.publisher_id), lastSyncedAt: String(data.last_synced_at ?? data.connected_at) };
  }

  async fetchRevenue(q: { from: string; to: string }): Promise<RevenuePoint[]> {
    const { data, error } = await this.db.from("revenue_daily").select("game_id,day,currency,earnings_micros").gte("day", q.from).lte("day", q.to);
    if (error) throw new Error(error.message);
    return (data ?? []).map((r) => ({ date: String(r.day), appId: String(r.game_id), amount: Number(r.earnings_micros) / 1e6, currency: String(r.currency) }));
  }
}

export function revenueProviders(db: SupabaseClient, admobConfigured: boolean): RevenueProvider[] {
  return [new AdMobProvider(db, admobConfigured), new NotConnectedProvider("iap", "In-app purchases", "No store reporting source (App Store Connect / Google Play) is configured.")];
}
