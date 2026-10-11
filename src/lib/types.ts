import type { DocEntry, Monetization, Platform, WorkflowKind } from "./github/types";
import type { ProjectFacts } from "./github/project-facts";

export type GameType = "mini" | "premium";
export type DevStatus = "prototype" | "in_development" | "soft_launch" | "live" | "paused";

export const GAME_TYPE_LABEL: Record<GameType, string> = { mini: "Mini", premium: "Premium" };
export const DEV_STATUS_LABEL: Record<DevStatus, string> = {
  prototype: "Prototype",
  in_development: "In development",
  soft_launch: "Soft launch",
  live: "Live",
  paused: "Paused",
};
export const DEV_STATUSES = Object.keys(DEV_STATUS_LABEL) as DevStatus[];

export type GameRow = {
  id: string;
  created_at: string;
  updated_at: string;
  name: string;
  game_type: GameType;
  dev_status: DevStatus;
  github_installation_id: number;
  github_repo_id: number;
  owner: string;
  repo: string;
  full_name: string;
  html_url: string;
  description: string | null;
  default_branch: string;
  is_private: boolean;
  is_archived: boolean;
  repo_pushed_at: string | null;
  unity_detected: boolean;
  unity_version: string | null;
  unity_project_path: string | null;
  unity_note: string | null;
  docs: DocEntry[];
  monetization: Monetization;
  commit_sha: string | null;
  commit_message: string | null;
  commit_author: string | null;
  commit_at: string | null;
  commit_url: string | null;
  connected_at: string;
  last_synced_at: string;
  last_sync_error: string | null;
  pm_ref: string | null;
  project_facts: ProjectFacts;
};

export type WorkflowRow = {
  id: string;
  game_id: string;
  github_workflow_id: number | null;
  name: string;
  path: string;
  state: string | null;
  kinds: WorkflowKind[];
  platforms: Platform[];
  signals: string[];
  triggers: string[];
  ci_ref: string | null;
  ci_actions: string[];
  dispatchable: boolean;
  has_required_inputs: boolean;
  run_id: number | null;
  run_number: number | null;
  run_status: string | null;
  run_conclusion: string | null;
  run_event: string | null;
  run_branch: string | null;
  run_url: string | null;
  run_started_at: string | null;
  run_updated_at: string | null;
  updated_at: string;
};

export type BuildRunRow = {
  id: string;
  game_id: string;
  github_run_id: number;
  workflow_path: string;
  action: import("./ci/actions").CiAction | null;
  title: string | null;
  head_sha: string | null;
  head_branch: string | null;
  event: string | null;
  status: string | null;
  conclusion: string | null;
  run_number: number | null;
  html_url: string | null;
  started_at: string | null;
  completed_at: string | null;
  duration_s: number | null;
  failed_job: string | null;
  failed_step: string | null;
  version: string | null;
  build_number: number | null;
  bundle_id: string | null;
  unity_version: string | null;
  summary: {
    tests: { mode: string; total: number; passed: number; failed: number; skipped: number; failures: { name: string; message: string }[] } | null;
    errorSummary: string | null;
    artifacts: { name: string; bytes?: number; sha256?: string }[];
    notes: string[];
  } | null;
  artifacts: { id: number; name: string; size_bytes: number; expired: boolean; expires_at: string | null }[];
  synced_at: string;
};

export type ReleaseStatus = "candidate" | "approved" | "rejected" | "published_manually";
export type ReleaseRow = {
  id: string;
  created_at: string;
  game_id: string;
  platform: "android" | "ios";
  version: string;
  build_number: number;
  build_run_id: string | null;
  artifact_id: number | null;
  artifact_name: string | null;
  head_sha: string | null;
  readiness: { checks: { id: string; label: string; state: "pass" | "fail" | "warn" | "unknown"; detail: string }[]; blockers: number };
  status: ReleaseStatus;
  decided_by_email: string | null;
  decided_at: string | null;
  notes: string | null;
};
