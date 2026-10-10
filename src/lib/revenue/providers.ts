import type { ProviderConnection, RevenuePoint, RevenueProvider } from "./types";

/**
 * Placeholders for the future integrations. They intentionally never return data.
 * To implement AdMob: use the AdMob API (Network Report) with OAuth, store the refresh
 * token server-side, and replace `connection()` / `fetchRevenue()` below.
 */
class NotConnectedProvider implements RevenueProvider {
  constructor(
    readonly id: RevenueProvider["id"],
    readonly label: string,
    private readonly reason: string,
  ) {}
  async connection(): Promise<ProviderConnection> {
    return { state: "not_connected", reason: this.reason };
  }
  async fetchRevenue(): Promise<RevenuePoint[]> {
    throw new Error(`${this.label} is not connected`);
  }
}

export const revenueProviders: RevenueProvider[] = [
  new NotConnectedProvider("admob", "Google AdMob", "No AdMob account has been authorized."),
  new NotConnectedProvider("iap", "In-app purchases", "No store reporting source (App Store Connect / Google Play) is configured."),
];
