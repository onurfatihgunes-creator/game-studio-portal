import { describe, expect, it } from "vitest";
import { canApprove, evaluateAndroid, evaluateIos, isPlaceholderId } from "@/lib/ci/readiness";
import type { BuildRunRow, GameRow, ReleaseRow } from "@/lib/types";

const HEAD = "aaaaaaa1111111";
const game = (over: Partial<GameRow> = {}, facts: Partial<GameRow["project_facts"]> = {}): GameRow => ({
  commit_sha: HEAD, is_archived: false,
  project_facts: { checked: true, companyName: "Acme Games", androidBundleId: "com.acme.runner", iosBundleId: "com.acme.runner", version: "1.2.0", androidVersionCode: 5, iosBuildNumber: "5", androidTargetSdk: 35, appleTeamId: "TEAM123456", ...facts },
  ...over,
}) as GameRow;
const run = (action: string, over: Partial<BuildRunRow> = {}): BuildRunRow => ({
  id: "r" + Math.random(), action, status: "completed", conclusion: "success", head_sha: HEAD, started_at: "2026-10-10T10:00:00Z", failed_step: null,
  version: "1.2.0", build_number: 6, artifacts: [{ id: 1, name: "android-release-1", size_bytes: 30e6, expired: false, expires_at: null }], ...over,
}) as BuildRunRow;
const find = (r: ReturnType<typeof evaluateAndroid>, id: string) => r.checks.find((c) => c.id === id)!;

describe("readiness: never claims what it cannot see", () => {
  it("no runs at all → unknowns, not passes", () => {
    const r = evaluateAndroid(game(), [], []);
    expect(find(r, "tests").state).toBe("unknown");
    expect(find(r, "build").state).toBe("unknown");
    expect(find(r, "artifact").state).toBe("unknown");
    expect(find(r, "signing").state).toBe("unknown");
  });
  it("a fully green release candidate passes every check", () => {
    const r = evaluateAndroid(game(), [run("test-editmode"), run("test-playmode"), run("android-release")], []);
    expect(r.checks.every((c) => c.state === "pass")).toBe(true);
    expect(canApprove(r)).toBe(true);
  });
  it("a debug-signed dev APK can never be approved", () => {
    const r = evaluateAndroid(game(), [run("test-editmode"), run("android-dev")], []);
    expect(find(r, "signing").state).toBe("fail");
    expect(canApprove(r)).toBe(false);
  });
  it("passing tests on an older commit are only a warning; failing tests block", () => {
    expect(find(evaluateAndroid(game(), [run("test-editmode", { head_sha: "bbbbbbb" })], []), "tests").state).toBe("warn");
    const bad = evaluateAndroid(game(), [run("test-editmode", { conclusion: "failure" })], []);
    expect(find(bad, "tests").state).toBe("fail");
    expect(canApprove(bad)).toBe(false);
  });
  it("uses the NEWEST run per action", () => {
    const runs = [run("test-editmode", { conclusion: "failure", started_at: "2026-10-09T10:00:00Z" }), run("test-editmode", { started_at: "2026-10-10T10:00:00Z" })];
    expect(find(evaluateAndroid(game(), runs, []), "tests").state).toBe("pass");
  });
  it("flags placeholder identity (Unity defaults) and missing ids", () => {
    expect(find(evaluateAndroid(game({}, { companyName: "DefaultCompany" }), [], []), "identity").state).toBe("fail");
    expect(find(evaluateAndroid(game({}, { androidBundleId: "com.DefaultCompany.Game" }), [], []), "identity").state).toBe("fail");
    expect(find(evaluateAndroid(game({}, { androidBundleId: null }), [], []), "identity").state).toBe("fail");
    expect(find(evaluateAndroid(game({ project_facts: { checked: false } } as Partial<GameRow>), [], []), "identity").state).toBe("unknown");
    expect(isPlaceholderId("com.acme.runner")).toBe(false);
    expect(isPlaceholderId("com.company.product")).toBe(true);
  });
  it("build number must exceed the last approved release", () => {
    const prior = [{ platform: "android", status: "approved", build_number: 6, version: "1.1.0" }] as ReleaseRow[];
    expect(find(evaluateAndroid(game(), [run("android-release", { build_number: 6 })], prior), "version").state).toBe("fail");
    expect(find(evaluateAndroid(game(), [run("android-release", { build_number: 7 })], prior), "version").state).toBe("pass");
    // rejected candidates do not count
    expect(find(evaluateAndroid(game(), [run("android-release", { build_number: 6 })], [{ ...prior[0], status: "rejected" }] as ReleaseRow[]), "version").state).toBe("pass");
  });
  it("auto target API warns; expired artifacts fail; archived repos fail", () => {
    expect(find(evaluateAndroid(game({}, { androidTargetSdk: 0 }), [], []), "target-api").state).toBe("warn");
    const expired = run("android-release", { artifacts: [{ id: 1, name: "x", size_bytes: 1, expired: true, expires_at: null }] });
    expect(find(evaluateAndroid(game(), [expired], []), "artifact").state).toBe("fail");
    expect(find(evaluateAndroid(game({ is_archived: true }), [], []), "repo").state).toBe("fail");
  });
});

describe("iOS readiness", () => {
  it("needs a real unsigned-validation run, a bundle id, and warns without an Apple team", () => {
    const none = evaluateIos(game(), [], []);
    expect(none.checks.find((c) => c.id === "validate")!.state).toBe("unknown");
    const noTeam = evaluateIos(game({}, { appleTeamId: null }), [run("test-editmode"), run("ios-validate")], []);
    expect(noTeam.checks.find((c) => c.id === "team")!.state).toBe("warn");
    expect(canApprove(noTeam)).toBe(true); // warnings do not block; a person decides
    expect(canApprove(evaluateIos(game({}, { iosBundleId: null }), [run("ios-validate")], []))).toBe(false);
  });
});
