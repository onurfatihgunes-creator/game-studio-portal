/**
 * Revenue reporting contracts. NOTHING here fabricates data: until a provider is
 * actually configured, every provider reports `not_connected` and returns no figures.
 */

export type ProviderId = "admob";

export type ProviderConnection =
  | { state: "not_connected"; reason: string }
  | { state: "connected"; accountLabel: string; lastSyncedAt: string };

export type RevenueQuery = {
  /** ISO dates, inclusive */
  from: string;
  to: string;
  /** Provider-specific app identifiers (AdMob app id, store bundle id, ...) */
  appIds?: string[];
};

export type RevenuePoint = {
  date: string; // YYYY-MM-DD
  appId: string;
  /** Minor currency units (micros for AdMob) are converted by the provider; always paired with currency. */
  amount: number;
  currency: string;
};

export interface RevenueProvider {
  readonly id: ProviderId;
  readonly label: string;
  /** Cheap check of configuration; must not call the network. */
  connection(): Promise<ProviderConnection>;
  /** Only called when connection().state === "connected". */
  fetchRevenue(query: RevenueQuery): Promise<RevenuePoint[]>;
}
