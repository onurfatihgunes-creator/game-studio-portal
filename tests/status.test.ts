import { describe, expect, it } from "vitest";
import { gameSummary, platformReadiness, runState } from "@/lib/status";
import type { GameRow, WorkflowRow } from "@/lib/types";

const wf = (over: Partial<WorkflowRow>): WorkflowRow => ({
  id: "1", game_id: "g", github_workflow_id: 1, name: "w", path: ".github/workflows/w.yml", state: "active",
  kinds: [], platforms: [], signals: [], triggers: [], dispatchable: false, has_required_inputs: false,
  run_id: null, run_number: null, run_status: null, run_conclusion: null, run_event: null, run_branch: null,
  run_url: null, run_started_at: null, run_updated_at: null, updated_at: "", ...over,
});
const game = { unity_detected: true, monetization: { checked: true, admob: false, iap: false, other_ads: [] } } as unknown as GameRow;
const done = (c: string) => ({ run_id: 1, run_status: "completed", run_conclusion: c });

describe("status derivation", () => {
  it("maps run conclusions", () => {
    expect(runState(wf({}))).toBe("no_runs");
    expect(runState(wf({ run_id: 1, run_status: "in_progress" }))).toBe("running");
    expect(runState(wf(done("success")))).toBe("passing");
    expect(runState(wf(done("timed_out")))).toBe("failing");
    expect(runState(wf(done("cancelled")))).toBe("other");
  });

  it("is not_configured with no workflows, never assumed ready", () => {
    const s = gameSummary(game, []);
    expect(s).toMatchObject({ tests: "not_configured", build: "not_configured", android: "not_configured", ios: "not_configured", publishing: "not_configured" });
    expect(s.monetization.state).toBe("not_configured");
  });

  it("platform readiness requires a build workflow that names the platform", () => {
    const build = wf({ kinds: ["build"], platforms: ["android"], ...done("success") });
    expect(platformReadiness(game, [build], "android")).toBe("passing");
    expect(platformReadiness(game, [build], "ios")).toBe("not_configured");
    expect(platformReadiness(game, [wf({ kinds: ["build"], platforms: [] })], "android")).toBe("not_configured");
    expect(platformReadiness({ unity_detected: false }, [build], "android")).toBe("not_configured");
  });

  it("any failure wins over success", () => {
    const ws = [wf({ kinds: ["test"], ...done("success") }), wf({ id: "2", kinds: ["test"], ...done("failure") })];
    expect(gameSummary(game, ws).tests).toBe("failing");
  });
});
