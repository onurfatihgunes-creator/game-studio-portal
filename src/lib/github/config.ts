import "server-only";
import { readGitHubConfig, type GitHubConfig } from "./app";

/** Throws a readable error for server actions when the GitHub App is not configured. */
export function requireGitHubConfig(): GitHubConfig {
  const r = readGitHubConfig();
  if (!r.ok) throw new Error(`GitHub App is not configured. Missing: ${r.missing.join(", ")}`);
  return r.config;
}
