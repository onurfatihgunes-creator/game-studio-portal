import type { ProjectFacts } from "./project-facts";
export type WorkflowKind = "test" | "build" | "publish";
export type Platform = "android" | "ios";

export type DocEntry = { path: string; kind: "readme" | "changelog" | "contributing" | "agent-guide" | "design" | "docs-folder" | "other" };

export type Monetization = {
  /** false when Packages/manifest.json could not be read, so nothing could be detected */
  checked: boolean;
  admob?: boolean;
  iap?: boolean;
  other_ads?: string[];
};

export type RunSummary = {
  id: number;
  number: number;
  status: string | null;
  conclusion: string | null;
  event: string;
  branch: string | null;
  url: string;
  startedAt: string | null;
  updatedAt: string | null;
};

export type ScannedWorkflow = {
  ciRef: string | null;
  ciActions: string[];
  githubWorkflowId: number | null;
  name: string;
  path: string;
  state: string | null;
  kinds: WorkflowKind[];
  platforms: Platform[];
  signals: string[];
  triggers: string[];
  dispatchable: boolean;
  hasRequiredInputs: boolean;
  latestRun: RunSummary | null;
};

export type ScanResult = {
  scannedAt: string;
  repo: {
    id: number;
    installationId: number;
    owner: string;
    name: string;
    fullName: string;
    htmlUrl: string;
    description: string | null;
    defaultBranch: string;
    isPrivate: boolean;
    isArchived: boolean;
    pushedAt: string | null;
  };
  latestCommit: { sha: string; message: string; author: string | null; date: string | null; url: string } | null;
  unity: { detected: boolean; version: string | null; projectPath: string | null; note: string | null };
  docs: DocEntry[];
  monetization: Monetization;
  workflows: ScannedWorkflow[];
  projectFacts: ProjectFacts;
};
