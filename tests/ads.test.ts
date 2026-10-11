import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { adsStatus, DEMO_UNITS, emptyConfig, exportForUnity, normalizeConfig, testDefaults, validateConfig } from "@/lib/ads/config";
import { applyTestDefaults, saveAdsConfig } from "@/lib/ads/store";
import { evaluateAndroid, evaluateIos } from "@/lib/ci/readiness";
import type { GameRow } from "@/lib/types";
import { memdb } from "./memdb";

const PROD = normalizeConfig({
  enabled: true, test_mode: false,
  android: { app_id: "ca-app-pub-1111222233334444~1234567890", rewarded: "ca-app-pub-1111222233334444/1111111111", interstitial: "ca-app-pub-1111222233334444/2222222222" },
  caps: { interstitial_min_interval_s: 120, interstitial_max_per_session: 5, interstitial_first_delay_s: 45, interstitial_min_runs_before_first: 3, rewarded_cooldown_s: 10 },
  consent: { tag_child_directed: false, tag_under_age_of_consent: true, max_ad_content_rating: "PG" },
});
const errors = (c: ReturnType<typeof emptyConfig>) => validateConfig(c).filter((p) => p.level === "error");

describe("ads config validation", () => {
  it("a disabled/empty config is valid and reports honestly", () => {
    expect(errors(emptyConfig())).toEqual([]);
    expect(adsStatus(null)).toBe("not_configured");
    expect(adsStatus(emptyConfig())).toBe("disabled");
  });
  it("test defaults use Google's demo ids, are disabled, and are valid", () => {
    const t = testDefaults();
    expect(t.enabled).toBe(false);
    expect(t.test_mode).toBe(true);
    expect(t.android.rewarded).toBe(DEMO_UNITS.android.rewarded);
    expect(errors(t)).toEqual([]);
    expect(adsStatus({ ...t, enabled: true })).toBe("test");
  });
  it("a correct production config is production_ready", () => {
    expect(errors(PROD)).toEqual([]);
    expect(adsStatus(PROD)).toBe("production_ready");
  });
  it("rejects malformed ids and mixed publishers", () => {
    expect(errors({ ...PROD, android: { ...PROD.android, rewarded: "nonsense" } }).length).toBe(1);
    expect(errors({ ...PROD, android: { ...PROD.android, interstitial: "ca-app-pub-9999888877776666/2222222222" } }).some((e) => /same AdMob publisher/.test(e.message))).toBe(true);
    expect(adsStatus({ ...PROD, android: { ...PROD.android, app_id: "bad" } })).toBe("invalid");
  });
  it("production mode refuses Google demo ids and missing app ids", () => {
    const demo = normalizeConfig({ ...testDefaults(), enabled: true, test_mode: false });
    expect(errors(demo).some((e) => /demo ID/.test(e.message))).toBe(true);
    expect(errors({ ...PROD, android: { rewarded: PROD.android.rewarded } }).some((e) => /app ID/.test(e.message))).toBe(true);
    expect(errors({ ...PROD, android: { app_id: PROD.android.app_id } }).some((e) => /at least one ad unit/.test(e.message))).toBe(true);
  });
  it("normalizes untrusted input: trims, clamps, defaults to test mode", () => {
    const n = normalizeConfig({ android: { rewarded: "  ca-app-pub-1111222233334444/1111111111  " }, caps: { interstitial_min_interval_s: -5, interstitial_max_per_session: 99999 } as never });
    expect(n.test_mode).toBe(true);
    expect(n.android.rewarded).toBe("ca-app-pub-1111222233334444/1111111111");
    expect(n.caps.interstitial_min_interval_s).toBe(0);
    expect(n.caps.interstitial_max_per_session).toBe(100);
    expect(normalizeConfig({ consent: { max_ad_content_rating: "XXX" } as never }).consent.max_ad_content_rating).toBe("");
  });
});

describe("Unity export contract", () => {
  it("matches the fixture the C# parser test also reads", () => {
    const fixture = JSON.parse(readFileSync("tests/fixtures/StudioAdsConfig.sample.json", "utf8"));
    expect(exportForUnity(PROD)).toEqual(fixture);
  });
});

describe("ads in release readiness", () => {
  const game = { commit_sha: "a1", is_archived: false, project_facts: { checked: true, companyName: "Acme", androidBundleId: "com.acme.x", iosBundleId: "com.acme.x", androidTargetSdk: 35, appleTeamId: "T", version: "1", androidVersionCode: 1 } } as GameRow;
  const check = (ads: Parameters<typeof evaluateAndroid>[4]) => evaluateAndroid(game, [], [], undefined, ads).checks.find((c) => c.id === "ads");
  it("is absent unless the caller loaded ads; unknown when none recorded", () => {
    expect(check(undefined)).toBeUndefined();
    expect(check(null)!.state).toBe("unknown");
  });
  it("disabled → pass; enabled in test mode → FAIL (would ship demo ads); production → pass", () => {
    expect(check({ ...emptyConfig(), enabled: false })!.state).toBe("pass");
    expect(check({ ...testDefaults(), enabled: true })!.state).toBe("fail");
    expect(check(PROD)!.state).toBe("pass");
  });
  it("production ads without the iOS app id fail the iOS check only", () => {
    expect(evaluateIos(game, [], [], undefined, PROD).checks.find((c) => c.id === "ads")!.state).toBe("fail");
    expect(evaluateAndroid(game, [], [], undefined, PROD).checks.find((c) => c.id === "ads")!.state).toBe("pass");
  });
});

describe("ads store", () => {
  it("server-side validation blocks invalid configs and persists valid ones", async () => {
    const db = memdb({ game_ads_config: [] });
    await expect(saveAdsConfig(db, "g1", { ...PROD, android: { ...PROD.android, rewarded: "bad" } }, "a@b.c")).rejects.toThrow(/Ad unit ID/);
    await saveAdsConfig(db, "g1", PROD, "a@b.c");
    const row = (await db.from("game_ads_config").select().eq("game_id", "g1").maybeSingle()).data;
    expect(row).toMatchObject({ enabled: true, test_mode: false, updated_by_email: "a@b.c" });
    await saveAdsConfig(db, "g1", { ...PROD, enabled: false }, "x@y.z"); // upsert, not duplicate
    expect((await db.from("game_ads_config").select()).data).toHaveLength(1);
  });
  it("batch test defaults never overwrite an existing config", async () => {
    const db = memdb({ game_ads_config: [{ game_id: "g1", enabled: true, test_mode: false }] });
    expect(await applyTestDefaults(db, ["g1", "g2", "g3"], "a@b.c")).toBe(2);
    const rows = (await db.from("game_ads_config").select()).data;
    expect(rows.find((r: any) => r.game_id === "g1")).toMatchObject({ enabled: true, test_mode: false });
    expect(rows.find((r: any) => r.game_id === "g2")).toMatchObject({ enabled: false, test_mode: true });
    expect(await applyTestDefaults(db, [], null)).toBe(0);
  });
});
