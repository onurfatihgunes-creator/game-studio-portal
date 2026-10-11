import type { DocEntry, Monetization } from "./github/types";
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
