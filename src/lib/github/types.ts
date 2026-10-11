import type { ProjectFacts } from "./project-facts";
export type DocEntry = { path: string; kind: "readme" | "changelog" | "contributing" | "agent-guide" | "design" | "docs-folder" | "other" };

export type Monetization = {
  /** false when Packages/manifest.json could not be read, so nothing could be detected */
  checked: boolean;
  admob?: boolean;
  iap?: boolean;
  other_ads?: string[];
  /** shared Unity ads module (com.studio.ads) facts; absent = not scanned yet */
  studio_ads?: { module_version: string | null; config_file: boolean };
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
  projectFacts: ProjectFacts;
};
