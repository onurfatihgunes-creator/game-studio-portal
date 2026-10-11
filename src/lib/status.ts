import type { GameRow, WorkflowRow } from "./types";

/**
 * Derived statuses. Pure functions over stored GitHub data.
 * Rule: no evidence → "not_configured". We never infer readiness from absence.
 */

export type RunState = "passing" | "failing" | "running" | "no_runs" | "other";

export function runState(w: Pick<WorkflowRow, "run_id" | "run_status" | "run_conclusion">): RunState {
  if (w.run_id === null) return "no_runs";
  if (w.run_status !== "completed") return "running";
  switch (w.run_conclusion) {
    case "success":
      return "passing";
    case "failure":
    case "timed_out":
    case "startup_failure":
      return "failing";
    default:
      return "other"; // cancelled, skipped, neutral, action_required, stale
  }
}

export type Aggregate = "not_configured" | "no_runs" | "running" | "passing" | "failing" | "other";

function aggregate(workflows: WorkflowRow[]): Aggregate {
  if (workflows.length === 0) return "not_configured";
  const states = workflows.map(runState);
  if (states.includes("failing")) return "failing";
  if (states.includes("running")) return "running";
  if (states.includes("passing")) return "passing";
  if (states.includes("other")) return "other";
  return "no_runs";
}

export const testStatus = (ws: WorkflowRow[]) => aggregate(ws.filter((w) => w.kinds.includes("test")));
export const buildStatus = (ws: WorkflowRow[]) => aggregate(ws.filter((w) => w.kinds.includes("build")));
export const publishStatus = (ws: WorkflowRow[]) => aggregate(ws.filter((w) => w.kinds.includes("publish")));

export type PlatformReadiness = "not_configured" | "no_runs" | "running" | "passing" | "failing" | "other";

/** A platform is only "configured" if a build workflow explicitly targets it. */
export function platformReadiness(game: Pick<GameRow, "unity_detected">, ws: WorkflowRow[], platform: "android" | "ios"): PlatformReadiness {
  if (!game.unity_detected) return "not_configured";
  return aggregate(ws.filter((w) => w.kinds.includes("build") && w.platforms.includes(platform)));
}

export type MonetizationSummary = { state: "not_configured" | "unknown" | "detected"; items: string[] };

export function monetizationSummary(game: Pick<GameRow, "monetization" | "unity_detected">): MonetizationSummary {
  const m = game.monetization;
  if (!game.unity_detected || !m?.checked) return { state: "unknown", items: [] };
  const items: string[] = [];
  if (m.admob) items.push("AdMob SDK");
  if (m.iap) items.push("Unity IAP");
  if (m.studio_ads?.module_version) items.push("Studio ads module");
  for (const o of m.other_ads ?? []) items.push(o);
  return items.length ? { state: "detected", items } : { state: "not_configured", items };
}

export const AGGREGATE_LABEL: Record<Aggregate, string> = {
  not_configured: "Not configured",
  no_runs: "No runs yet",
  running: "Running",
  passing: "Passing",
  failing: "Failing",
  other: "Inconclusive",
};

export type Tone = "good" | "bad" | "warn" | "muted" | "info";
export const AGGREGATE_TONE: Record<Aggregate, Tone> = {
  not_configured: "muted",
  no_runs: "warn",
  running: "info",
  passing: "good",
  failing: "bad",
  other: "warn",
};

export function conclusionLabel(w: Pick<WorkflowRow, "run_id" | "run_status" | "run_conclusion">): string {
  if (w.run_id === null) return "No runs";
  if (w.run_status !== "completed") return w.run_status === "queued" ? "Queued" : "Running";
  return (w.run_conclusion ?? "completed").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

export function gameSummary(game: GameRow, ws: WorkflowRow[]) {
  return {
    tests: testStatus(ws),
    build: buildStatus(ws),
    android: platformReadiness(game, ws, "android"),
    ios: platformReadiness(game, ws, "ios"),
    publishing: publishStatus(ws),
    monetization: monetizationSummary(game),
  };
}
