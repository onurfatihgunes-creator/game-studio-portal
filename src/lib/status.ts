import type { GameRow } from "./types";

/** Derived display state. Pure functions over stored GitHub data. No evidence → "unknown", never assumed. */

export type MonetizationSummary = { state: "not_configured" | "unknown" | "detected"; items: string[] };

export function monetizationSummary(game: Pick<GameRow, "monetization" | "unity_detected">): MonetizationSummary {
  const m = game.monetization;
  if (!game.unity_detected || !m?.checked) return { state: "unknown", items: [] };
  const items: string[] = [];
  if (m.admob) items.push("AdMob SDK");
  if (m.studio_ads?.module_version) items.push("Studio ads module");
  for (const o of m.other_ads ?? []) items.push(o);
  return items.length ? { state: "detected", items } : { state: "not_configured", items };
}

export type Tone = "good" | "bad" | "warn" | "muted" | "info";
