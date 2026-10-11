import { describe, expect, it } from "vitest";
import { normalizeConfig, testDefaults } from "@/lib/ads/config";
import { detectStudioAds, findIdConflicts, integrationChecklist, onboardCommand, parseIdImport, planImport } from "@/lib/ads/integration";
import { applyIdImport, previewIdImport, saveAdsConfig } from "@/lib/ads/store";
import { detectMonetization } from "@/lib/github/classify";
import { memdb } from "./memdb";

// Fake IDs only (shape-valid). Real AdMob IDs must never appear in this public repository.
const A = { app_id: "ca-app-pub-1111222233334444~1111111111", rewarded: "ca-app-pub-1111222233334444/1000000001", interstitial: "ca-app-pub-1111222233334444/1000000002", banner: "ca-app-pub-1111222233334444/1000000003" };
const B = { app_id: "ca-app-pub-1111222233334444~2222222222", rewarded: "ca-app-pub-1111222233334444/2000000001", interstitial: "ca-app-pub-1111222233334444/2000000002", banner: "ca-app-pub-1111222233334444/2000000003" };
const cfg = (android = {}) => normalizeConfig({ android });
const csv = (game: string, p = "android", i = A) => `${game},${p},${i.app_id},${i.banner},${i.interstitial},${i.rewarded}`;

describe("module detection", () => {
  it("finds a vendored package, a manifest reference, and the runtime config", () => {
    expect(detectStudioAds({ packageJson: '{"name":"com.studio.ads","version":"0.2.0"}', manifest: null, configJson: "{}" })).toEqual({ module_version: "0.2.0", config_file: true });
    expect(detectStudioAds({ packageJson: null, manifest: '{"dependencies":{"com.studio.ads":"file:../x"}}', configJson: null })).toEqual({ module_version: "referenced in manifest", config_file: false });
  });
  it("treats absent or malformed files as not installed, never as a guess", () => {
    expect(detectStudioAds({ packageJson: null, manifest: null, configJson: null })).toEqual({ module_version: null, config_file: false });
    expect(detectStudioAds({ packageJson: "{oops", manifest: "{oops", configJson: "{oops" })).toEqual({ module_version: null, config_file: false });
    expect(detectStudioAds({ packageJson: '{"name":"other"}', manifest: null, configJson: null }).module_version).toBeNull();
  });
  it("the Google plugin is still detected from the manifest", () => {
    expect(detectMonetization('{"dependencies":{"com.google.ads.mobile":"11.5.0"}}').admob).toBe(true);
  });
});

describe("cross-game ID uniqueness", () => {
  it("flags an ID that another game already owns, but exempts Google demo IDs", () => {
    const others = [{ gameId: "g2", name: "Other", cfg: cfg(A) }];
    expect(findIdConflicts("g1", cfg(A), others)[0]).toMatchObject({ otherName: "Other", where: "android.app_id" });
    expect(findIdConflicts("g1", cfg(B), others)).toEqual([]);
    expect(findIdConflicts("g1", testDefaults(), [{ gameId: "g2", name: "Other", cfg: testDefaults() }])).toEqual([]);
    expect(findIdConflicts("g2", cfg(A), others)).toEqual([]); // a game never conflicts with itself
  });
  it("saveAdsConfig refuses to reuse another game's ID", async () => {
    const db = memdb({ games: [{ id: "g1", name: "One", full_name: "o/one", repo: "one" }, { id: "g2", name: "Two", full_name: "o/two", repo: "two" }], game_ads_config: [] });
    await saveAdsConfig(db as never, "g1", { android: A }, "u@x");
    await expect(saveAdsConfig(db as never, "g2", { android: { ...B, rewarded: A.rewarded } }, "u@x")).rejects.toThrow(/already belongs to One/);
    await saveAdsConfig(db as never, "g2", { android: B }, "u@x");
  });
});

describe("integration checklist", () => {
  const base = { unity_detected: true, androidBundleId: "com.x.y", studioAds: null as null | { module_version: string | null; config_file: boolean }, googlePlugin: null as boolean | null };
  it("reports unknown before a scan, todo after a scan that found nothing", () => {
    expect(integrationChecklist(base, null).find((i) => i.key === "module")!.state).toBe("unknown");
    const scanned = integrationChecklist({ ...base, studioAds: { module_version: null, config_file: false }, googlePlugin: false }, null);
    expect(scanned.filter((i) => ["module", "plugin", "file", "ids"].includes(i.key)).every((i) => i.state === "todo")).toBe(true);
  });
  it("is green only when installed, own IDs set, and production requests are off", () => {
    const list = integrationChecklist({ ...base, studioAds: { module_version: "0.2.0", config_file: true }, googlePlugin: true }, normalizeConfig({ android: A }));
    expect(list.every((i) => i.state === "ok")).toBe(true);
    expect(integrationChecklist({ ...base, studioAds: { module_version: "0.2.0", config_file: true }, googlePlugin: true }, normalizeConfig({ enabled: true, test_mode: false, android: A })).find((i) => i.key === "prod")!.state).toBe("warn");
  });
  it("the onboarding command is a dry run by default", () => {
    expect(onboardCommand("o/r", true)).toBe("tools/onboard.sh --with-ads --with-google-plugin o/r");
    expect(onboardCommand("o/r", false)).not.toMatch(/--apply/);
  });
});

describe("ID import", () => {
  const games = [{ id: "g1", name: "One", full_name: "o/one", repo: "one" }, { id: "g2", name: "Two", full_name: "o/two", repo: "two" }];
  const plan = (text: string, existing = new Map<string, ReturnType<typeof cfg>>()) => planImport(parseIdImport(text).rows, games, existing, (id) => games.find((g) => g.id === id)!.name);

  it("rejects malformed rows with line numbers", () => {
    const r = parseIdImport(`${csv("o/one")}\no/one,windows,x\no/one,android,nope`);
    expect(r.rows).toHaveLength(1);
    expect(r.errors.map((e) => e.slice(0, 7))).toEqual(["Line 2:", "Line 3:"]);
  });
  it("creates, fills demo/empty, and never silently overwrites own IDs", () => {
    expect(plan(csv("o/one"))[0].action).toBe("create");
    expect(plan(csv("o/one"), new Map([["g1", testDefaults()]]))[0].action).toBe("fill");
    expect(plan(csv("o/one", "android", B), new Map([["g1", cfg(A)]]))[0].action).toBe("needs_approval");
    expect(plan(csv("o/one"), new Map([["g1", cfg(A)]]))[0].action).toBe("same");
  });
  it("blocks IDs owned by another game, duplicates inside the import, and unknown games", () => {
    expect(plan(csv("o/one"), new Map([["g2", cfg(A)]]))[0]).toMatchObject({ action: "conflict" });
    expect(plan(`${csv("o/one")}\n${csv("o/two")}`).map((p) => p.action)).toEqual(["create", "conflict"]);
    expect(plan(csv("o/ghost"))[0].action).toBe("unknown_game");
  });
  it("apply: creates disabled test-mode configs, needs explicit approval to overwrite, never applies conflicts", async () => {
    const db = memdb({ games, game_ads_config: [] });
    const text = `${csv("o/one")}\n${csv("o/two", "android", B)}`;
    expect((await previewIdImport(db as never, text)).plan.map((p) => p.action)).toEqual(["create", "create"]);
    expect(await applyIdImport(db as never, text, [], "u@x")).toEqual({ applied: 2, skipped: 0 });
    const rows = (await db.from("game_ads_config").select("*")).data as { enabled: boolean; test_mode: boolean }[];
    expect(rows.every((r) => r.enabled === false && r.test_mode === true)).toBe(true);

    const change = csv("o/one", "android", { ...A, rewarded: "ca-app-pub-1111222233334444/1000000009" });
    expect(await applyIdImport(db as never, change, [], "u@x")).toEqual({ applied: 0, skipped: 1 });       // not approved
    expect(await applyIdImport(db as never, change, [1], "u@x")).toEqual({ applied: 1, skipped: 0 });      // approved line 1
    expect(await applyIdImport(db as never, csv("o/two", "android", A), [1], "u@x")).toEqual({ applied: 0, skipped: 1 }); // conflict even when "approved"
  });
});
