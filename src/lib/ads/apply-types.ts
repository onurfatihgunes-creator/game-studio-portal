/** Client-safe types and labels for the "Apply to All Games" result. */
export type ApplyStatus = "applied" | "pr_open" | "needs_ids" | "needs_integration" | "failed";
export type ApplyAction = "none" | "created_pr" | "updated_pr" | "blocked";

export type ApplyResult = {
  gameId: string;
  name: string;
  fullName: string;
  status: ApplyStatus;
  detail: string;
  action: ApplyAction;
  /** module version found in the DEFAULT branch (null = not installed there) */
  moduleVersion: string | null;
  /** game-specific placement hooks verified in the default branch (null = unknown) */
  hooks: boolean | null;
  prNumber: number | null;
  prUrl: string | null;
  branch: string | null;
};

export const STATUS_LABEL: Record<ApplyStatus | "not_applied", string> = {
  applied: "Applied",
  pr_open: "Pull request awaiting approval",
  needs_ids: "Needs AdMob IDs",
  needs_integration: "Needs game integration",
  failed: "Failed",
  not_applied: "Not applied yet",
};
export const STATUS_TONE: Record<ApplyStatus | "not_applied", "good" | "info" | "warn" | "bad" | "muted"> = {
  applied: "good", pr_open: "info", needs_ids: "warn", needs_integration: "warn", failed: "bad", not_applied: "muted",
};
