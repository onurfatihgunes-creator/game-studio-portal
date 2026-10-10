import type { DocEntry, Monetization, Platform, WorkflowKind } from "./github/types";

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
