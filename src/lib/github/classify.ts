import type { Monetization } from "./types";

/** Pure repository-content helpers (no network). */
// ── Unity ───────────────────────────────────────────────────────────
export function parseUnityVersion(projectVersionTxt: string): string | null {
  const m = projectVersionTxt.match(/^m_EditorVersion:\s*(\S+)/m);
  return m ? m[1] : null;
}

// ── Monetization (package manifest) ─────────────────────────────────
export function detectMonetization(manifestJson: string | null): Monetization {
  if (manifestJson === null) return { checked: false };
  let manifest: { dependencies?: Record<string, string>; scopedRegistries?: { scopes?: string[] }[] };
  try {
    manifest = JSON.parse(manifestJson);
  } catch {
    return { checked: false };
  }
  const deps = Object.keys(manifest.dependencies ?? {}).map((d) => d.toLowerCase());
  const scopes = (manifest.scopedRegistries ?? []).flatMap((r) => r.scopes ?? []).map((s) => s.toLowerCase());
  const all = [...deps, ...scopes];
  const has = (needle: string) => all.some((d) => d.includes(needle));

  const other: string[] = [];
  if (has("levelplay") || has("ironsource")) other.push("Unity LevelPlay / ironSource");
  if (has("com.unity.ads") || has("unity.services.ads") || has("com.unity.monetization")) other.push("Unity Ads");
  if (has("applovin")) other.push("AppLovin");

  return {
    checked: true,
    admob: has("com.google.ads.mobile") || has("googlemobileads") || has("google-mobile-ads"),
    iap: has("com.unity.purchasing"),
    other_ads: other,
  };
}

// ── Docs ────────────────────────────────────────────────────────────
export function docKind(path: string): "readme" | "changelog" | "contributing" | "agent-guide" | "design" | "other" | null {
  const base = path.split("/").pop() ?? path;
  if (/^readme(\.|$)/i.test(base)) return "readme";
  if (/^changelog(\.|$)/i.test(base)) return "changelog";
  if (/^contributing(\.|$)/i.test(base)) return "contributing";
  if (/^(claude|agents)\.md$/i.test(base)) return "agent-guide";
  if (/^(gdd|design|game[-_ ]?design)[^/]*\.(md|pdf|docx?)$/i.test(base)) return "design";
  return null;
}
