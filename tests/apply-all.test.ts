import { readFileSync } from "node:fs";
import { gzipSync } from "fflate";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { applyToGame, buildNewConfig, cmpVersion, fillEmptyIds, INTEGRATION_BRANCH, mergeConfigAdditive, patchManifest, PR_MARKER, type ApplyDeps, type ApplyGame } from "@/lib/ads/apply";
import { buildBundle, loadModuleBundle, readTar, clearBundleCache } from "@/lib/ads/bundle";
import { normalizeConfig, type AdsConfig } from "@/lib/ads/config";
import { DEFAULT_POLICY, normalizePolicy, toRemoteJson } from "@/lib/ads/policy";
import { publishPolicy, verifyPublished } from "@/lib/ads/policy-store";
import type { FileChange, PullRequest, RepoGit } from "@/lib/github/repo-git";
import { memdb } from "./memdb";

// ── fakes ───────────────────────────────────────────────────────────────
const REMOTE = "https://proj.supabase.co/storage/v1/object/public/ads-policy/policy.json";
// Fake IDs only (shape-valid). Real AdMob IDs must never appear in this public repository.
const A = { app_id: "ca-app-pub-1111222233334444~1111111111", rewarded: "ca-app-pub-1111222233334444/1000000001", interstitial: "ca-app-pub-1111222233334444/1000000002", banner: "ca-app-pub-1111222233334444/1000000003" };
const B = { app_id: "ca-app-pub-5555666677778888~2222222222", rewarded: "ca-app-pub-5555666677778888/2000000001", interstitial: "ca-app-pub-5555666677778888/2000000002", banner: "ca-app-pub-5555666677778888/2000000003" };
const cfgOf = (android: object): AdsConfig => normalizeConfig({ android });

const bundle = buildBundle([
  { path: "Packages/com.studio.ads/package.json", content: JSON.stringify({ name: "com.studio.ads", version: "0.4.0" }) },
  { path: "Packages/com.studio.ads/Runtime/StudioAds.cs", content: "// runtime 0.4.0" },
  { path: "Packages/com.studio.ads/Runtime/NewFile.cs", content: "// new in 0.4.0" },
  { path: "Packages/com.studio.ads/Samples~/GoogleMobileAds/StudioAdsGoogleBackend.cs", content: "// adapter" },
  { path: "Packages/com.studio.ads/Samples~/GoogleMobileAds/Editor/StudioAdsGoogleSettingsSync.cs", content: "// sync" },
  { path: "Packages/com.studio.ads/Templates~/StudioAds.folder.meta", content: "folder-meta" },
], "ads-v0.4.0");

class FakeRepo implements RepoGit {
  branches = new Map<string, Map<string, string>>();
  prs: PullRequest[] = [];
  commits: { branch: string; files: FileChange[] }[] = [];
  readonly defaultBranch = "main";
  constructor(readonly fullName: string, files: Record<string, string>) { this.branches.set("main", new Map(Object.entries(files))); }
  async readFile(path: string, ref = "main") { return this.branches.get(ref)?.get(path) ?? null; }
  async listPaths(ref: string) { return { paths: [...(this.branches.get(ref)?.keys() ?? [])], complete: true }; }
  async openPullRequests() { return this.prs.filter((p) => p.state === "open"); }
  async pullRequestsForBranch(b: string) { return this.prs.filter((p) => p.head === b); }
  async branchExists(b: string) { return this.branches.has(b); }
  async commit({ branch, createFrom, files }: { branch: string; createFrom: string; message: string; files: FileChange[] }) {
    if (!this.branches.has(branch)) this.branches.set(branch, new Map(this.branches.get(createFrom)!));
    const tree = this.branches.get(branch)!;
    for (const f of files) f.content === null ? tree.delete(f.path) : tree.set(f.path, f.content);
    this.commits.push({ branch, files });
    return `sha${this.commits.length}`;
  }
  async openPullRequest(i: { head: string; base: string; title: string; body: string }) {
    if (this.prs.some((p) => p.head === i.head && p.state === "open")) throw new Error("422 A pull request already exists");
    const pr: PullRequest = { number: this.prs.length + 1, url: `https://github.com/${this.fullName}/pull/${this.prs.length + 1}`, head: i.head, base: i.base, title: i.title, body: i.body, state: "open", merged: false };
    this.prs.push(pr);
    return pr;
  }
  async updatePullRequest(n: number, patch: { body?: string; title?: string }) { Object.assign(this.prs.find((p) => p.number === n)!, patch); }
}

const unityFiles = (extra: Record<string, string> = {}) => ({
  "ProjectSettings/ProjectVersion.txt": "m_EditorVersion: 6000.0.1f1",
  "Packages/manifest.json": JSON.stringify({ dependencies: { "com.unity.ugui": "2.0.0" } }, null, 2),
  "Assets/Game.cs": "// gameplay",
  ...extra,
});
const game = (over: Partial<ApplyGame> = {}): ApplyGame => ({ id: "g1", name: "Game One", full_name: "o/one", unity_detected: true, unity_project_path: "", is_archived: false, ...over });
const deps = (git: RepoGit, over: Partial<ApplyDeps> = {}): ApplyDeps => ({ git, bundle, policy: DEFAULT_POLICY, remoteUrl: REMOTE, canWrite: true, others: [], ...over });
const writes = (r: FakeRepo) => r.commits.length + r.prs.length;

describe("shared policy contract", () => {
  it("matches the fixture the Unity module parses", () => {
    const fixture = JSON.parse(readFileSync("tests/fixtures/StudioAdsPolicy.sample.json", "utf8"));
    const p = normalizePolicy({ enabled: true, banner_enabled: true, banner_position: "bottom", interstitial: DEFAULT_POLICY.interstitial, rewarded_available: false, rewarded_cooldown_s: 0 });
    expect(toRemoteJson(p, 7, fixture.publishedAt)).toEqual(fixture);
  });
  it("can never switch production on or carry IDs", () => {
    const p = normalizePolicy({ test_mode: false as never, enabled: true, android: A } as never);
    expect(p.test_mode).toBe(true);
    expect(JSON.stringify(toRemoteJson(p, 1, "t"))).not.toMatch(/ca-app-pub/);
    expect(toRemoteJson(p, 1, "t").testMode).toBe(true);
  });
  it("defaults: ads off, the approved interstitial rules, rewarded off", () => {
    expect(DEFAULT_POLICY).toMatchObject({ enabled: false, rewarded_available: false, interstitial: { every_n_runs: 3, min_interval_s: 90, max_per_session: 6 } });
    expect(normalizePolicy({ interstitial: { every_n_runs: 0 } as never }).interstitial.every_n_runs).toBe(1);
  });
});

describe("Apply to one game", () => {
  it("a game without its own IDs gets a safe DISABLED integration and stays Needs AdMob IDs; nothing is invented", async () => {
    for (const own of [null, normalizeConfig({}), cfgOf({ app_id: "ca-app-pub-3940256099942544~3347511713", rewarded: "ca-app-pub-3940256099942544/5224354917" }), cfgOf({ app_id: A.app_id })]) {
      const repo = new FakeRepo("o/one", unityFiles());
      const r = await applyToGame(deps(repo), game(), own);
      expect(r).toMatchObject({ status: "needs_ids", action: "created_pr", prNumber: 1 });
      expect(r.detail).toMatch(/no AdMob app ID and ad units of its own/i);
      const cfg = JSON.parse(repo.branches.get(INTEGRATION_BRANCH)!.get("Assets/Resources/StudioAdsConfig.json")!);
      expect(cfg).toMatchObject({ enabled: false, testMode: true, android: { appId: "", rewarded: "", interstitial: "", banner: "" }, ios: { appId: "" }, remotePolicyUrl: REMOTE });
      expect(JSON.stringify(cfg)).not.toMatch(/ca-app-pub/);                   // no identifier of any kind, demo ids included
      expect(repo.prs[0].body).toMatch(/no AdMob identifiers yet/);
    }
  });

  it("is repeatable without IDs, then fills ONLY empty identifiers in the same pull request once the game has its own", async () => {
    const repo = new FakeRepo("o/one", unityFiles());
    await applyToGame(deps(repo), game(), null);
    const n = writes(repo);
    expect(await applyToGame(deps(repo), game(), null)).toMatchObject({ status: "needs_ids", action: "none", prNumber: 1 });
    expect(writes(repo)).toBe(n);                                                // no duplicate PR, no new commit

    const r = await applyToGame(deps(repo), game(), cfgOf(A));                  // the game's own IDs were saved meanwhile
    expect(r).toMatchObject({ status: "pr_open", action: "updated_pr", prNumber: 1 });
    expect(repo.prs).toHaveLength(1);
    const cfg = JSON.parse(repo.branches.get(INTEGRATION_BRANCH)!.get("Assets/Resources/StudioAdsConfig.json")!);
    expect(cfg.android).toEqual({ appId: A.app_id, rewarded: A.rewarded, interstitial: A.interstitial, banner: A.banner });
    expect(cfg).toMatchObject({ enabled: false, testMode: true });               // still disabled, still test mode
    expect((await applyToGame(deps(repo), game(), cfgOf(A))).action).toBe("none");
  });

  it("never replaces a non-empty identifier already in a config", async () => {
    expect(fillEmptyIds(JSON.stringify({ android: { appId: "mine", rewarded: "", interstitial: "keep" } }), cfgOf(A)).text).toContain('"appId": "mine"');
    const out = JSON.parse(fillEmptyIds(JSON.stringify({ android: { appId: "mine", rewarded: "", interstitial: "keep" } }), cfgOf(A)).text);
    expect(out.android).toMatchObject({ appId: "mine", rewarded: A.rewarded, interstitial: "keep" });
    expect(fillEmptyIds(JSON.stringify({ android: { appId: "mine" } }), null).changed).toBe(false);
  });

  it("prepares a new integration: one branch, one PR, own IDs only, disabled + test mode, default branch untouched", async () => {
    const repo = new FakeRepo("o/one", unityFiles());
    const r = await applyToGame(deps(repo), game(), cfgOf(A));
    expect(r).toMatchObject({ status: "pr_open", action: "created_pr", prNumber: 1, branch: INTEGRATION_BRANCH });
    expect(repo.commits).toHaveLength(1);
    expect(repo.commits[0].branch).toBe(INTEGRATION_BRANCH);
    const tree = repo.branches.get(INTEGRATION_BRANCH)!;
    expect(tree.get("Packages/com.studio.ads/package.json")).toContain("0.4.0");
    expect(tree.get("Assets/StudioAds/StudioAdsGoogleBackend.cs")).toBe("// adapter");
    expect(tree.get("Assets/StudioAds.meta")).toBe("folder-meta");
    const cfg = JSON.parse(tree.get("Assets/Resources/StudioAdsConfig.json")!);
    expect(cfg).toMatchObject({ enabled: false, testMode: true, remotePolicyUrl: REMOTE, rewardedAvailable: false, android: { appId: A.app_id, interstitial: A.interstitial }, ios: { appId: "" } });
    expect(JSON.parse(tree.get("Packages/manifest.json")!).dependencies["com.google.ads.mobile"]).toBe("11.5.0");
    expect(JSON.parse(tree.get("Assets/StudioAds/StudioAdsPlacements.json")!).hooks).toBeNull();
    expect(tree.get("Assets/Resources/StudioAdsConfig.json.meta")).toMatch(/guid: [0-9a-f]{32}/);
    expect(tree.get("Assets/Game.cs")).toBe("// gameplay");                      // gameplay untouched
    expect(repo.branches.get("main")!.has("Packages/com.studio.ads/package.json")).toBe(false); // default branch untouched
    expect(repo.prs[0].body).toContain(PR_MARKER);
  });

  it("is repeatable: running again creates no commit, no PR, no duplicate", async () => {
    const repo = new FakeRepo("o/one", unityFiles());
    await applyToGame(deps(repo), game(), cfgOf(A));
    const before = writes(repo);
    for (let i = 0; i < 3; i++) {
      const r = await applyToGame(deps(repo), game(), cfgOf(A));
      expect(r).toMatchObject({ status: "pr_open", action: "none", prNumber: 1 });
    }
    expect(writes(repo)).toBe(before);
    expect(repo.prs).toHaveLength(1);
  });

  it("reuses an existing (legacy) pull request instead of opening a second one, preserving its IDs", async () => {
    const repo = new FakeRepo("o/one", unityFiles());
    repo.branches.set("studio-ci-onboarding", new Map(repo.branches.get("main")!));
    const old = repo.branches.get("studio-ci-onboarding")!;
    old.set("Packages/com.studio.ads/package.json", JSON.stringify({ name: "com.studio.ads", version: "0.3.1" }));
    old.set("Packages/com.studio.ads/Runtime/Removed.cs", "// gone in 0.4.0");
    const existingCfg = { schema: 1, enabled: false, testMode: true, android: { appId: A.app_id, rewarded: A.rewarded, interstitial: A.interstitial, banner: A.banner }, caps: { interstitialEveryNRuns: 3 } };
    old.set("Assets/Resources/StudioAdsConfig.json", JSON.stringify(existingCfg));
    repo.prs.push({ number: 1, url: "https://github.com/o/one/pull/1", head: "studio-ci-onboarding", base: "main", title: "Add studio Unity CI", body: "legacy body", state: "open", merged: false });

    const r = await applyToGame(deps(repo), game(), cfgOf(A));
    expect(r).toMatchObject({ status: "pr_open", action: "updated_pr", prNumber: 1, branch: "studio-ci-onboarding" });
    expect(repo.prs).toHaveLength(1);
    expect(repo.branches.has(INTEGRATION_BRANCH)).toBe(false);
    expect(old.get("Packages/com.studio.ads/package.json")).toContain("0.4.0");
    expect(old.has("Packages/com.studio.ads/Runtime/Removed.cs")).toBe(false);
    const cfg = JSON.parse(old.get("Assets/Resources/StudioAdsConfig.json")!);
    expect(cfg.android).toEqual(existingCfg.android);                    // existing IDs untouched
    expect(cfg.caps).toEqual({ interstitialEveryNRuns: 3 });             // existing values untouched
    expect(cfg).toMatchObject({ remotePolicyUrl: REMOTE, rewardedAvailable: false });
    const n = writes(repo);
    expect((await applyToGame(deps(repo), game(), cfgOf(A))).action).toBe("none");   // and again: nothing
    expect(writes(repo)).toBe(n);
  });

  it("each game gets only its OWN identifiers, and a reused identifier is refused", async () => {
    const one = new FakeRepo("o/one", unityFiles()), two = new FakeRepo("o/two", unityFiles());
    await applyToGame(deps(one), game(), cfgOf(A));
    await applyToGame(deps(two), game({ id: "g2", name: "Two", full_name: "o/two" }), cfgOf(B));
    const cfgTwo = one.branches.get(INTEGRATION_BRANCH) && two.branches.get(INTEGRATION_BRANCH)!.get("Assets/Resources/StudioAdsConfig.json")!;
    expect(cfgTwo).toContain(B.app_id);
    expect(cfgTwo).not.toContain("1111222233334444");                    // nothing from game one
    const three = new FakeRepo("o/three", unityFiles());
    const r = await applyToGame(deps(three, { others: [{ gameId: "g1", name: "Game One", cfg: cfgOf(A) }] }), game({ id: "g3", name: "Three", full_name: "o/three" }), cfgOf(A));
    expect(r).toMatchObject({ status: "failed" });
    expect(r.detail).toMatch(/already belongs to Game One/);
    expect(writes(three)).toBe(0);
  });

  it("Applied needs the module AND verified hooks AND the remote config; otherwise Needs game integration", async () => {
    const withModule = {
      "Packages/com.studio.ads/package.json": JSON.stringify({ name: "com.studio.ads", version: "0.4.0" }),
      "Assets/Resources/StudioAdsConfig.json": JSON.stringify({ remotePolicyUrl: REMOTE, android: { appId: A.app_id, rewarded: A.rewarded, interstitial: A.interstitial, banner: A.banner } }),
    };
    const noHooks = new FakeRepo("o/one", unityFiles(withModule));
    expect((await applyToGame(deps(noHooks), game(), cfgOf(A))).status).toBe("needs_integration");
    const declaredButMissing = new FakeRepo("o/one", unityFiles({ ...withModule, "Assets/StudioAds/StudioAdsPlacements.json": JSON.stringify({ schema: 1, hooks: "Assets/Ads/Hooks.cs" }) }));
    expect((await applyToGame(deps(declaredButMissing), game(), cfgOf(A))).status).toBe("needs_integration");
    const full = new FakeRepo("o/one", unityFiles({ ...withModule, "Assets/StudioAds/StudioAdsPlacements.json": JSON.stringify({ schema: 1, hooks: "Assets/Ads/Hooks.cs" }), "Assets/Ads/Hooks.cs": "// hooks" }));
    expect(await applyToGame(deps(full), game(), cfgOf(A))).toMatchObject({ status: "applied", hooks: true, moduleVersion: "0.4.0", action: "none" });
    expect(writes(full) + writes(noHooks)).toBe(0);
    // module merged but without the remote-policy key: not "applied", an update PR is prepared
    const noRemote = new FakeRepo("o/one", unityFiles({ "Packages/com.studio.ads/package.json": withModule["Packages/com.studio.ads/package.json"], "Assets/Resources/StudioAdsConfig.json": "{}" }));
    expect((await applyToGame(deps(noRemote), game(), cfgOf(A))).action).toBe("created_pr");
  });

  it("without write permission it changes nothing and says so", async () => {
    const repo = new FakeRepo("o/one", unityFiles());
    const r = await applyToGame(deps(repo, { canWrite: false }), game(), cfgOf(A));
    expect(r).toMatchObject({ status: "failed", action: "blocked" });
    expect(r.detail).toMatch(/Pull requests: Read & write/);
    expect(writes(repo)).toBe(0);
  });

  it("a GitHub App without the Pull requests permission gets a clear message, not a raw 403", async () => {
    const repo = new FakeRepo("o/one", unityFiles());
    repo.openPullRequests = async () => { throw Object.assign(new Error("GitHub 403 on /pulls"), { status: 403 }); };
    const r = await applyToGame(deps(repo, { canWrite: false }), game(), cfgOf(A));
    expect(r).toMatchObject({ status: "failed", action: "blocked" });
    expect(r.detail).toMatch(/no Pull requests permission/);
    expect(writes(repo)).toBe(0);
  });

  it("does not recreate a closed integration PR, and skips archived / non-Unity repositories", async () => {
    const repo = new FakeRepo("o/one", unityFiles());
    repo.branches.set(INTEGRATION_BRANCH, new Map());
    const r = await applyToGame(deps(repo), game(), cfgOf(A));
    expect(r.status).toBe("failed");
    expect(r.detail).toMatch(/Delete the branch/);
    expect(writes(repo)).toBe(0);
    expect((await applyToGame(deps(repo), game({ is_archived: true }), cfgOf(A))).status).toBe("failed");
    expect((await applyToGame(deps(repo), game({ unity_detected: false }), cfgOf(A))).status).toBe("needs_integration");
  });

  it("works for a Unity project in a subfolder", async () => {
    const repo = new FakeRepo("o/one", { "App/ProjectSettings/ProjectVersion.txt": "x", "App/Packages/manifest.json": "{}" });
    const r = await applyToGame(deps(repo), game({ unity_project_path: "App" }), cfgOf(A));
    expect(r.status).toBe("pr_open");
    expect(repo.branches.get(INTEGRATION_BRANCH)!.has("App/Packages/com.studio.ads/package.json")).toBe(true);
    expect(repo.branches.get(INTEGRATION_BRANCH)!.has("Packages/com.studio.ads/package.json")).toBe(false);
  });
});

describe("pure helpers", () => {
  it("compares versions numerically", () => {
    expect(cmpVersion("0.3.1", "0.4.0")).toBe(-1);
    expect(cmpVersion("0.10.0", "0.4.0")).toBe(1);
    expect(cmpVersion("1.0.0", "1.0.0")).toBe(0);
  });
  it("manifest patch is additive and idempotent", () => {
    const once = patchManifest(JSON.stringify({ dependencies: { a: "1" }, scopedRegistries: [{ name: "X", url: "https://x", scopes: ["x"] }] }));
    expect(JSON.parse(once.text).scopedRegistries).toHaveLength(2);
    expect(patchManifest(once.text).changed).toBe(false);
    expect(patchManifest(JSON.stringify({ dependencies: { "com.google.ads.mobile": "10.0.0" } })).text).toContain("10.0.0"); // never downgrades/changes
  });
  it("config merge never changes an existing value", () => {
    const m = mergeConfigAdditive(JSON.stringify({ remotePolicyUrl: "https://mine", enabled: true }), { remotePolicyUrl: REMOTE, rewardedAvailable: false });
    expect(JSON.parse(m.text)).toEqual({ remotePolicyUrl: "https://mine", enabled: true, rewardedAvailable: false });
    expect(mergeConfigAdditive("not json", { a: 1 })).toEqual({ text: "not json", changed: false });
  });
  it("a new config uses only the given game's IDs and is disabled in test mode", () => {
    const c = JSON.parse(buildNewConfig(cfgOf(B), normalizePolicy({ enabled: true, rewarded_available: true }), REMOTE));
    expect(c).toMatchObject({ enabled: false, testMode: true, rewardedAvailable: true, remotePolicyUrl: REMOTE, android: { appId: B.app_id } });
  });
});

describe("module bundle from a tarball", () => {
  beforeAll(() => clearBundleCache());
  afterEach(() => { vi.unstubAllGlobals(); clearBundleCache(); });
  function tar(entries: { path: string; body: string }[]): Uint8Array {
    const blocks: Uint8Array[] = [];
    const enc = new TextEncoder();
    const header = (name: string, size: number, type: string) => {
      const h = new Uint8Array(512);
      h.set(enc.encode(name.slice(0, 100)), 0);
      h.set(enc.encode(size.toString(8).padStart(11, "0")), 124);
      h[156] = type.charCodeAt(0);
      return h;
    };
    const add = (name: string, body: string, type = "0") => {
      const b = enc.encode(body);
      blocks.push(header(name, b.length, type), b, new Uint8Array((512 - (b.length % 512)) % 512));
    };
    add("pax_global_header", "52 comment=abc\n", "g");
    for (const e of entries) {
      if (e.path.length > 99) add("PaxHeader", `${e.path.length + 10} path=${e.path}\n`, "x");
      add(e.path.length > 99 ? "short" : e.path, e.body);
    }
    blocks.push(new Uint8Array(1024));
    const out = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
    let o = 0; for (const b of blocks) { out.set(b, o); o += b.length; }
    return out;
  }
  it("reads files (including pax long paths), strips the root folder and keeps only the module", async () => {
    const long = "Packages/com.studio.ads/Samples~/GoogleMobileAds/" + "deep/".repeat(15) + "File.cs";
    const archive = gzipSync(tar([
      { path: "o-unity-ci-abc/Packages/com.studio.ads/package.json", body: JSON.stringify({ name: "com.studio.ads", version: "0.4.0" }) },
      { path: `o-unity-ci-abc/${long}`, body: "// long" },
      { path: "o-unity-ci-abc/docs/private-plan.md", body: "PRIVATE" },
      { path: "o-unity-ci-abc/Packages/com.studio.ci/x.cs", body: "// other package" },
    ]));
    expect(readTar(new Uint8Array(archive.length ? tar([{ path: "r/a.txt", body: "hi" }]) : new Uint8Array())).map((e) => e.path)).toEqual(["r/a.txt"]);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toContain("/repos/o/unity-ci/tarball/ads-v0.4.0");
      return new Response(archive, { status: 200 });
    }));
    const b = await loadModuleBundle("tok", { repo: "o/unity-ci", ref: "ads-v0.4.0" });
    expect(b.version).toBe("0.4.0");
    expect(b.module.map((f) => f.path)).toContain("Packages/com.studio.ads/package.json");
    expect(b.module.every((f) => f.path.startsWith("Packages/com.studio.ads/"))).toBe(true);   // private docs and the CI package never leave unity-ci
    expect(b.adapter.some((f) => f.path.startsWith("Assets/StudioAds/deep/") && f.path.endsWith("File.cs"))).toBe(true);
  });
});

describe("remote policy publishing", () => {
  const store = () => {
    const files = new Map<string, string>();
    const db = memdb({ ads_policy: [] }) as ReturnType<typeof memdb> & { storage: unknown };
    (db as { storage: unknown }).storage = { from: () => ({ upload: async (name: string, blob: Blob) => { files.set(name, await blob.text()); return { error: null }; } }) };
    const fetcher = async (url: string) => ({ ok: files.has("policy.json"), status: files.has("policy.json") ? 200 : 404, text: async () => files.get("policy.json") ?? "", url });
    return { db, files, fetcher };
  };
  const env = process.env.NEXT_PUBLIC_SUPABASE_URL;
  beforeAll(() => { process.env.NEXT_PUBLIC_SUPABASE_URL = "https://proj.supabase.co"; });
  afterEach(() => { process.env.NEXT_PUBLIC_SUPABASE_URL = "https://proj.supabase.co"; });

  it("publishes v1, keeps the version when nothing changed, bumps it on a change, and confirms the public file", async () => {
    const { db, files, fetcher } = store();
    const p1 = await publishPolicy(db, { ...DEFAULT_POLICY }, "a@b.c", { fetcher });
    expect(p1).toMatchObject({ version: 1, changed: true, verified: true });
    expect(JSON.parse(files.get("policy.json")!)).toMatchObject({ schema: 1, policyVersion: 1, enabled: false, testMode: true, interstitial: { everyNRuns: 3 } });
    expect((await publishPolicy(db, { ...DEFAULT_POLICY }, "a@b.c", { fetcher })).changed).toBe(false);   // repeat → no churn
    const p2 = await publishPolicy(db, { ...DEFAULT_POLICY, interstitial: { ...DEFAULT_POLICY.interstitial, every_n_runs: 5 } }, "a@b.c", { fetcher });
    expect(p2).toMatchObject({ version: 2, changed: true, verified: true });
    expect(JSON.parse(files.get("policy.json")!).interstitial.everyNRuns).toBe(5);                        // the public file carries the change
    expect(process.env.NEXT_PUBLIC_SUPABASE_URL).toBeDefined();
    void env;
  });
  it("reports an unreachable or stale public file honestly", async () => {
    expect((await verifyPublished(REMOTE, 3, async () => ({ ok: false, status: 404, text: async () => "" }))).ok).toBe(false);
    expect((await verifyPublished(REMOTE, 3, async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ schema: 1, policyVersion: 2 }) }))).note).toMatch(/still shows policy v2/);
    expect((await verifyPublished(REMOTE, 3, async () => ({ ok: true, status: 200, text: async () => "<html>" }))).ok).toBe(false);
  });
});
