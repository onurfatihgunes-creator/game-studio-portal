import { generateKeyPairSync } from "node:crypto";
import { zipSync, strToU8 } from "fflate";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parsePortalResult, readPortalResultZip } from "@/lib/ci/result";
import { buildRunRow, jobsSummary, syncGameBuilds } from "@/lib/github/runs";
import type { GameRow, WorkflowRow } from "@/lib/types";

let pem: string;
beforeAll(() => { pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString(); });
afterEach(() => vi.unstubAllGlobals());

const GOOD = { schema: 1, action: "test-editmode", sha: "ABCDEF1234567", branch: "main", unityVersion: "6000.6.3f1", durationS: 111,
  tests: { mode: "EditMode", total: 242, passed: 209, failed: 1, skipped: 32, failures: [{ name: "Planner.Fairness", message: "expected 1 got 2" }] }, errorSummary: "1 test failed" };

describe("portal-result validation (untrusted input)", () => {
  it("accepts a valid result and normalises it", () => {
    const r = parsePortalResult(GOOD)!;
    expect(r.action).toBe("test-editmode");
    expect(r.sha).toBe("abcdef1234567");
    expect(r.tests).toMatchObject({ total: 242, failed: 1 });
  });
  it("rejects wrong schema, unknown actions and garbage", () => {
    expect(parsePortalResult({ ...GOOD, schema: 2 })).toBeNull();
    expect(parsePortalResult({ ...GOOD, action: "publish-to-store" })).toBeNull();
    expect(parsePortalResult("x")).toBeNull();
    expect(parsePortalResult(null)).toBeNull();
  });
  it("drops invalid fields instead of repairing them, and caps sizes", () => {
    const r = parsePortalResult({ ...GOOD, sha: "not a sha; rm -rf", durationS: -5, tests: { mode: "EditMode", total: "many", passed: 1, failed: 0, skipped: 0 },
      errorSummary: "x".repeat(5000), artifacts: Array.from({ length: 50 }, (_, i) => ({ name: `a${i}`, sha256: "zz" })) })!;
    expect(r.sha).toBeUndefined();
    expect(r.durationS).toBeUndefined();
    expect(r.tests).toBeUndefined();
    expect(r.errorSummary).toHaveLength(2000);
    expect(r.artifacts).toHaveLength(20);
    expect(r.artifacts![0].sha256).toBeUndefined();
  });
  it("reads it out of an artifact zip and refuses oversize/invalid zips", () => {
    const zip = zipSync({ "portal-result.json": strToU8(JSON.stringify(GOOD)) });
    expect(readPortalResultZip(zip)?.tests?.total).toBe(242);
    expect(readPortalResultZip(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(readPortalResultZip(zipSync({ "portal-result.json": strToU8("{bad json") }))).toBeNull();
    expect(readPortalResultZip(zipSync({ "portal-result.json": strToU8(" ".repeat(70 * 1024)) }))).toBeNull();
  });
});

describe("run → build_runs mapping", () => {
  const run = { id: 7, run_number: 3, run_attempt: 1, status: "completed", conclusion: "failure", event: "workflow_dispatch", head_sha: "abc1234", head_branch: "main",
    html_url: "https://x/run/7", display_title: "android-dev", run_started_at: "2026-10-10T10:00:00Z", created_at: "2026-10-10T09:59:00Z", updated_at: "2026-10-10T10:12:00Z" };
  const jobs = [{ name: "ci / unity", status: "completed", conclusion: "failure", started_at: "2026-10-10T10:00:10Z", completed_at: "2026-10-10T10:11:50Z",
    steps: [{ name: "Checkout", conclusion: "success" }, { name: "Build Android", conclusion: "failure" }] }];
  it("derives action from the run title, duration from jobs, and the failed step", () => {
    expect(jobsSummary(jobs)).toEqual({ durationS: 700, failedJob: "ci / unity", failedStep: "Build Android" });
    const row = buildRunRow("g1", ".github/workflows/unity-ci.yml", run, jobs, [
      { id: 1, name: "android-dev-3", size_in_bytes: 37_607_082, expired: false, expires_at: "2026-10-17T10:12:00Z" },
      { id: 2, name: "portal-result-3", size_in_bytes: 400, expired: false, expires_at: null },
    ], null);
    expect(row).toMatchObject({ action: "android-dev", duration_s: 700, failed_step: "Build Android", conclusion: "failure", summary: null });
    expect(row.artifacts.map((a) => a.name)).toEqual(["android-dev-3"]); // the result file is not offered as a download
  });
  it("never invents results for runs without a portal-result", () => {
    const row = buildRunRow("g1", "w.yml", { ...run, display_title: "Fix typo" }, [], [], null);
    expect(row.action).toBeNull();
    expect(row.summary).toBeNull();
    expect(row.version).toBeNull();
  });
});

describe("syncGameBuilds against a fake GitHub + DB", () => {
  const game = { id: "g1", owner: "o", repo: "r", github_installation_id: 7 } as GameRow;
  const wf = { path: ".github/workflows/unity-ci.yml", ci_ref: "o/unity-ci/.github/workflows/unity-ci.yml@v1", github_workflow_id: 99 } as WorkflowRow;
  const cfg = () => ({ appId: "1", slug: null, privateKey: pem });
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

  function fake(stored: { github_run_id: number; status: string; conclusion: string | null }[]) {
    const calls: string[] = [];
    const resultZip = zipSync({ "portal-result.json": strToU8(JSON.stringify({ ...GOOD, action: "test-editmode" })) });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const u = new URL(typeof input === "string" ? input : input.toString()); calls.push(u.pathname);
      if (u.host === "blob.test") return new Response(resultZip);
      if (u.pathname.endsWith("/access_tokens")) return json({ token: "t", expires_at: new Date(Date.now() + 3.6e6).toISOString() }, 201);
      if (u.pathname.endsWith("/workflows/99/runs")) return json({ workflow_runs: [
        { id: 1, run_number: 1, run_attempt: 1, status: "completed", conclusion: "success", event: "workflow_dispatch", head_sha: "aaa1111", head_branch: "main", html_url: "u", display_title: "test-editmode", run_started_at: "2026-10-10T10:00:00Z", created_at: "2026-10-10T10:00:00Z", updated_at: "2026-10-10T10:02:00Z" },
        { id: 2, run_number: 2, run_attempt: 1, status: "in_progress", conclusion: null, event: "workflow_dispatch", head_sha: "bbb2222", head_branch: "main", html_url: "u", display_title: "android-dev", run_started_at: "2026-10-10T11:00:00Z", created_at: "2026-10-10T11:00:00Z", updated_at: "2026-10-10T11:01:00Z" },
      ] });
      if (u.pathname.endsWith("/jobs")) return json({ jobs: [] });
      if (u.pathname.endsWith("/runs/1/artifacts")) return json({ artifacts: [{ id: 50, name: "portal-result-1", size_in_bytes: 300, expired: false, expires_at: null }] });
      if (u.pathname.endsWith("/artifacts")) return json({ artifacts: [] });
      if (u.pathname.endsWith("/artifacts/50/zip")) return new Response(null, { status: 302, headers: { location: "https://blob.test/zip" } });
      return json({ message: "nf" }, 404);
    }));
    const upserts: any[] = [];
    const db: any = { from: () => ({
      select: () => ({ eq: () => ({ in: async () => ({ data: stored, error: null }) }) }),
      upsert: async (row: any) => { upserts.push(row); return { error: null }; },
    }) };
    return { db, upserts, calls };
  }

  it("stores new and running runs, parsing the result file of completed ones", async () => {
    const { db, upserts } = fake([]);
    expect(await syncGameBuilds(db, cfg(), game, [wf])).toBe(2);
    const done = upserts.find((r) => r.github_run_id === 1);
    expect(done.summary.tests.total).toBe(242);
    expect(done.action).toBe("test-editmode");
    expect(upserts.find((r) => r.github_run_id === 2).summary).toBeNull(); // still running: nothing invented
  });
  it("skips completed runs that are already stored (cheap refreshes)", async () => {
    const { db, upserts, calls } = fake([{ github_run_id: 1, status: "completed", conclusion: "success" }]);
    expect(await syncGameBuilds(db, cfg(), game, [wf])).toBe(1);
    expect(upserts.map((r) => r.github_run_id)).toEqual([2]);
    expect(calls.filter((c) => c.includes("/runs/1/"))).toEqual([]);
  });
  it("ignores workflows that are not the shared CI", async () => {
    const { db } = fake([]);
    expect(await syncGameBuilds(db, cfg(), game, [{ ...wf, ci_ref: null } as WorkflowRow])).toBe(0);
  });
});
