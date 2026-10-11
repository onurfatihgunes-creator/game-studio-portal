/**
 * The ONE shared advertising policy. Pure (no I/O), shared by the page, the server and the tests.
 *
 * Two kinds of settings, deliberately kept apart:
 *  - CENTRALLY EDITABLE policy (this file): banner on/off + position, interstitial frequency, rewarded availability, ads on/off.
 *    Published as a small public JSON file that integrated games fetch at runtime (no rebuild).
 *  - UNITY INTEGRATION requirements (per game, in the repository): the shared module, the Google plugin, the game's own AdMob IDs and
 *    the game-specific placement hooks. These can only change through a reviewed pull request.
 *
 * The central policy can never carry AdMob IDs, can never switch production ads on (test mode is always on here), and ads default to OFF.
 */
import type { Caps } from "./config";

export type AdsPolicy = {
  /** Ads allowed at all. Remote effect: in a game whose repo config is production this can only switch ads OFF, never on. */
  enabled: boolean;
  /** Always true centrally. Production requires an approved pull request per game. */
  test_mode: true;
  banner_enabled: boolean;
  banner_position: "top" | "bottom";
  interstitial: { min_interval_s: number; max_per_session: number; first_delay_s: number; min_runs_before_first: number; every_n_runs: number };
  rewarded_available: boolean;
  rewarded_cooldown_s: number;
};

export const DEFAULT_POLICY: AdsPolicy = {
  enabled: false,
  test_mode: true,
  banner_enabled: true,
  banner_position: "bottom",
  // the rules the owner approved for the first pilot: every 3rd completed run, >= 90 s apart, <= 6 per session
  interstitial: { min_interval_s: 90, max_per_session: 6, first_delay_s: 60, min_runs_before_first: 3, every_n_runs: 3 },
  rewarded_available: false,
  rewarded_cooldown_s: 0,
};

const clamp = (n: unknown, lo: number, hi: number, fallback: number) =>
  typeof n === "number" && Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.floor(n))) : fallback;

/** Coerces untrusted input into a well-formed policy. test_mode is forced on. */
export function normalizePolicy(input: Partial<AdsPolicy> | null | undefined): AdsPolicy {
  const i = (input ?? {}) as Partial<AdsPolicy>;
  const c = (i.interstitial ?? {}) as Partial<AdsPolicy["interstitial"]>;
  const d = DEFAULT_POLICY.interstitial;
  return {
    enabled: !!i.enabled,
    test_mode: true,
    banner_enabled: i.banner_enabled === undefined ? DEFAULT_POLICY.banner_enabled : !!i.banner_enabled,
    banner_position: i.banner_position === "top" ? "top" : "bottom",
    interstitial: {
      min_interval_s: clamp(c.min_interval_s, 0, 3600, d.min_interval_s),
      max_per_session: clamp(c.max_per_session, 0, 100, d.max_per_session),
      first_delay_s: clamp(c.first_delay_s, 0, 3600, d.first_delay_s),
      min_runs_before_first: clamp(c.min_runs_before_first, 0, 50, d.min_runs_before_first),
      every_n_runs: Math.max(1, clamp(c.every_n_runs, 1, 50, d.every_n_runs)),
    },
    rewarded_available: !!i.rewarded_available,
    rewarded_cooldown_s: clamp(i.rewarded_cooldown_s, 0, 3600, 0),
  };
}

/** The remote file contract (tests/fixtures/StudioAdsPolicy.sample.json; the Unity module parses exactly this). */
export function toRemoteJson(p: AdsPolicy, policyVersion: number, publishedAt: string) {
  return {
    schema: 1,
    policyVersion,
    publishedAt,
    enabled: p.enabled,
    testMode: true,
    banner: { enabled: p.banner_enabled, position: p.banner_position },
    interstitial: {
      minIntervalSec: p.interstitial.min_interval_s,
      maxPerSession: p.interstitial.max_per_session,
      firstDelaySec: p.interstitial.first_delay_s,
      minRunsBeforeFirst: p.interstitial.min_runs_before_first,
      everyNRuns: p.interstitial.every_n_runs,
    },
    rewarded: { available: p.rewarded_available, cooldownSec: p.rewarded_cooldown_s },
  };
}

/** Baseline caps written into a NEW game's repository config. Later policy changes go through the remote file, not new pull requests. */
export function policyCaps(p: AdsPolicy): Caps {
  return {
    interstitial_min_interval_s: p.interstitial.min_interval_s,
    interstitial_max_per_session: p.interstitial.max_per_session,
    interstitial_first_delay_s: p.interstitial.first_delay_s,
    interstitial_min_runs_before_first: p.interstitial.min_runs_before_first,
    interstitial_every_n_runs: p.interstitial.every_n_runs,
    rewarded_cooldown_s: p.rewarded_cooldown_s,
  };
}

export const samePolicy = (a: AdsPolicy, b: AdsPolicy) => JSON.stringify(normalizePolicy(a)) === JSON.stringify(normalizePolicy(b));

export type PolicyProblem = { field: string; message: string };

export function validatePolicy(p: AdsPolicy): PolicyProblem[] {
  const out: PolicyProblem[] = [];
  if (p.interstitial.every_n_runs < 1) out.push({ field: "every_n_runs", message: "Must be at least 1." });
  if (p.enabled && p.interstitial.max_per_session === 0 && !p.banner_enabled && !p.rewarded_available) out.push({ field: "enabled", message: "Ads are enabled but every format is off." });
  return out;
}
