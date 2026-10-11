import "server-only";
import { type GitHubConfig, getInstallationToken, ghPostNoContent } from "./app";

/** Fire a workflow_dispatch event. GitHub answers 204 with no run id. */
export async function dispatchWorkflow(
  config: GitHubConfig,
  installationId: number,
  owner: string,
  repo: string,
  workflowId: number,
  ref: string,
  inputs?: Record<string, string>,
): Promise<void> {
  const token = await getInstallationToken(config, installationId);
  await ghPostNoContent(
    token,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${workflowId}/dispatches`,
    inputs ? { ref, inputs } : { ref },
  );
}
