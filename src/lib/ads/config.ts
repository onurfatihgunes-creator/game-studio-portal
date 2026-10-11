/**
 * Per-game advertising configuration. The portal stores and validates it; the Unity module (com.studio.ads) executes it.
 * IDs are not secrets (they ship inside the app). Nothing here creates AdMob apps or ad units.
 */
export type PlatformIds = { app_id?: string; rewarded?: string; interstitial?: string; banner?: string };
export type Caps = {
  interstitial_min_interval_s: number;
  interstitial_max_per_session: number;
  interstitial_first_delay_s: number;
  interstitial_min_runs_before_first: number;
  /** eligible only after this many completed runs since the last interstitial (1 = every run) */
  interstitial_every_n_runs: number;
  rewarded_cooldown_s: number;
};
export type Consent = { tag_child_directed: boolean; tag_under_age_of_consent: boolean; max_ad_content_rating: "" | "G" | "PG" | "T" | "MA" };
export type AdsConfig = {
  enabled: boolean;
  test_mode: boolean;
  android: PlatformIds;
  ios: PlatformIds;
  banner_enabled: boolean;
  banner_position: "top" | "bottom";
  caps: Caps;
  consent: Consent;
  notes: string | null;
};

export const DEFAULT_CAPS: Caps = {
  interstitial_min_interval_s: 90,
  interstitial_max_per_session: 6,
  interstitial_first_delay_s: 60,
  interstitial_min_runs_before_first: 2,
  interstitial_every_n_runs: 1,
  rewarded_cooldown_s: 0,
};
export const DEFAULT_CONSENT: Consent = { tag_child_directed: false, tag_under_age_of_consent: false, max_ad_content_rating: "" };

/** Google's official demo ad units (verified against developers.google.com/admob/{android,ios,unity}/test-ads). */
export const DEMO_UNITS = {
  android: { rewarded: "ca-app-pub-3940256099942544/5224354917", interstitial: "ca-app-pub-3940256099942544/1033173712", banner: "ca-app-pub-3940256099942544/6300978111" },
  ios: { rewarded: "ca-app-pub-3940256099942544/1712485313", interstitial: "ca-app-pub-3940256099942544/4411468910", banner: "ca-app-pub-3940256099942544/2934735716" },
} as const;
/** Google's sample AdMob app IDs (commonly documented; not re-verified in this build). Used only as test-mode placeholders. */
export const DEMO_APP_IDS = { android: "ca-app-pub-3940256099942544~3347511713", ios: "ca-app-pub-3940256099942544~1458002511" } as const;

const DEMO_PUBLISHER = "ca-app-pub-3940256099942544";
export const APP_ID_RE = /^ca-app-pub-\d{16}~\d{10}$/;
export const UNIT_ID_RE = /^ca-app-pub-\d{16}\/\d{10}$/;
const publisherOf = (id: string) => id.split(/[~/]/)[0];

export function emptyConfig(): AdsConfig {
  return { enabled: false, test_mode: true, android: {}, ios: {}, banner_enabled: false, banner_position: "bottom", caps: { ...DEFAULT_CAPS }, consent: { ...DEFAULT_CONSENT }, notes: null };
}

/** A safe starting point: disabled, test mode, Google's demo IDs. Never contains real IDs. */
export function testDefaults(): AdsConfig {
  return { ...emptyConfig(), android: { app_id: DEMO_APP_IDS.android, ...DEMO_UNITS.android }, ios: { app_id: DEMO_APP_IDS.ios, ...DEMO_UNITS.ios } };
}

export type Problem = { level: "error" | "warning"; field: string; message: string };

const isDemo = (id?: string) => !!id && id.startsWith(DEMO_PUBLISHER);
const clamp = (n: unknown, lo: number, hi: number) => (typeof n === "number" && Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.floor(n))) : lo);

/** Coerces untrusted form/DB input into a well-formed config (strings trimmed, numbers clamped). Does not judge validity. */
export function normalizeConfig(input: Partial<AdsConfig> | null | undefined): AdsConfig {
  const i = input ?? {};
  const ids = (p?: PlatformIds): PlatformIds => {
    const out: PlatformIds = {};
    for (const k of ["app_id", "rewarded", "interstitial", "banner"] as const) {
      const v = typeof p?.[k] === "string" ? (p![k] as string).trim() : "";
      if (v) out[k] = v.slice(0, 80);
    }
    return out;
  };
  const c = (i.caps ?? {}) as Partial<Caps>;
  const cons = (i.consent ?? {}) as Partial<Consent>;
  return {
    enabled: !!i.enabled,
    test_mode: i.test_mode === undefined ? true : !!i.test_mode,
    android: ids(i.android),
    ios: ids(i.ios),
    banner_enabled: !!i.banner_enabled,
    banner_position: i.banner_position === "top" ? "top" : "bottom",
    caps: {
      interstitial_min_interval_s: clamp(c.interstitial_min_interval_s ?? DEFAULT_CAPS.interstitial_min_interval_s, 0, 3600),
      interstitial_max_per_session: clamp(c.interstitial_max_per_session ?? DEFAULT_CAPS.interstitial_max_per_session, 0, 100),
      interstitial_first_delay_s: clamp(c.interstitial_first_delay_s ?? DEFAULT_CAPS.interstitial_first_delay_s, 0, 3600),
      interstitial_min_runs_before_first: clamp(c.interstitial_min_runs_before_first ?? DEFAULT_CAPS.interstitial_min_runs_before_first, 0, 50),
      interstitial_every_n_runs: Math.max(1, clamp(c.interstitial_every_n_runs ?? DEFAULT_CAPS.interstitial_every_n_runs, 0, 50)),
      rewarded_cooldown_s: clamp(c.rewarded_cooldown_s ?? DEFAULT_CAPS.rewarded_cooldown_s, 0, 3600),
    },
    consent: {
      tag_child_directed: !!cons.tag_child_directed,
      tag_under_age_of_consent: !!cons.tag_under_age_of_consent,
      max_ad_content_rating: (["G", "PG", "T", "MA"] as const).includes(cons.max_ad_content_rating as "G") ? (cons.max_ad_content_rating as Consent["max_ad_content_rating"]) : "",
    },
    notes: typeof i.notes === "string" && i.notes.trim() ? i.notes.trim().slice(0, 500) : null,
  };
}

/**
 * Validation. Errors block saving; warnings are shown. Production rules apply only when ads are enabled and
 * test mode is off: every platform in use needs a well-formed app id + ad units from ONE publisher, none of them Google demos.
 */
export function validateConfig(cfg: AdsConfig): Problem[] {
  const out: Problem[] = [];
  for (const p of ["android", "ios"] as const) {
    const ids = cfg[p];
    if (ids.app_id && !APP_ID_RE.test(ids.app_id)) out.push({ level: "error", field: `${p}.app_id`, message: "App ID must look like ca-app-pub-1234567890123456~1234567890." });
    for (const k of ["rewarded", "interstitial", "banner"] as const) {
      const v = ids[k];
      if (v && !UNIT_ID_RE.test(v)) out.push({ level: "error", field: `${p}.${k}`, message: "Ad unit ID must look like ca-app-pub-1234567890123456/1234567890." });
    }
    const pubs = new Set([ids.app_id, ids.rewarded, ids.interstitial, ids.banner].filter((x): x is string => !!x && (APP_ID_RE.test(x) || UNIT_ID_RE.test(x))).map(publisherOf));
    if (pubs.size > 1) out.push({ level: "error", field: p, message: "App ID and ad units must belong to the same AdMob publisher." });
  }
  if (cfg.banner_enabled && !cfg.android.banner && !cfg.ios.banner) out.push({ level: "warning", field: "banner", message: "Banners are enabled but no banner ad unit is set." });
  if (cfg.consent.tag_child_directed && cfg.enabled) out.push({ level: "warning", field: "consent", message: "Child-directed treatment limits ad types and revenue; make sure this matches your store listing and legal review." });

  if (cfg.enabled && !cfg.test_mode) {
    for (const p of ["android", "ios"] as const) {
      const ids = cfg[p];
      const any = ids.app_id || ids.rewarded || ids.interstitial || ids.banner;
      if (!any) continue;
      if (!ids.app_id) out.push({ level: "error", field: `${p}.app_id`, message: `Production ads on ${p} need the AdMob app ID.` });
      if (!ids.rewarded && !ids.interstitial && !(cfg.banner_enabled && ids.banner)) out.push({ level: "error", field: p, message: `Production ads on ${p} need at least one ad unit.` });
      for (const k of ["app_id", "rewarded", "interstitial", "banner"] as const) {
        if (isDemo(ids[k])) out.push({ level: "error", field: `${p}.${k}`, message: "This is a Google demo ID; it earns nothing. Use your own ID or turn test mode on." });
      }
    }
    if (!cfg.android.app_id && !cfg.ios.app_id) out.push({ level: "error", field: "enabled", message: "Ads are enabled in production but no platform has IDs." });
  }
  return out;
}

export type AdsStatus = "not_configured" | "disabled" | "test" | "invalid" | "production_ready";

export function adsStatus(cfg: AdsConfig | null): AdsStatus {
  if (!cfg) return "not_configured";
  if (validateConfig(cfg).some((p) => p.level === "error")) return "invalid";
  if (!cfg.enabled) return "disabled";
  return cfg.test_mode ? "test" : "production_ready";
}

/** The JSON file the Unity module reads (Resources/StudioAdsConfig.json). Contract-tested against the C# parser. */
export function exportForUnity(cfg: AdsConfig, extra: { remotePolicyUrl?: string; rewardedAvailable?: boolean } = {}) {
  const ids = (p: PlatformIds) => ({ appId: p.app_id ?? "", rewarded: p.rewarded ?? "", interstitial: p.interstitial ?? "", banner: p.banner ?? "" });
  return {
    schema: 1,
    enabled: cfg.enabled,
    testMode: cfg.test_mode,
    android: ids(cfg.android),
    ios: ids(cfg.ios),
    banner: { enabled: cfg.banner_enabled, position: cfg.banner_position },
    caps: {
      interstitialMinIntervalSec: cfg.caps.interstitial_min_interval_s,
      interstitialMaxPerSession: cfg.caps.interstitial_max_per_session,
      interstitialFirstDelaySec: cfg.caps.interstitial_first_delay_s,
      interstitialMinRunsBeforeFirst: cfg.caps.interstitial_min_runs_before_first,
      interstitialEveryNRuns: cfg.caps.interstitial_every_n_runs,
      rewardedCooldownSec: cfg.caps.rewarded_cooldown_s,
    },
    consent: {
      tagForChildDirectedTreatment: cfg.consent.tag_child_directed,
      tagForUnderAgeOfConsent: cfg.consent.tag_under_age_of_consent,
      maxAdContentRating: cfg.consent.max_ad_content_rating,
    },
    // additive keys (module >= 0.4.0); omitted unless the caller provides them, so older exports stay byte-identical
    ...(extra.remotePolicyUrl !== undefined ? { remotePolicyUrl: extra.remotePolicyUrl } : {}),
    ...(extra.rewardedAvailable !== undefined ? { rewardedAvailable: extra.rewardedAvailable } : {}),
  };
}
