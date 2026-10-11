"use server";

import { revalidatePath } from "next/cache";
import { dispatchWorkflow } from "@/lib/github/dispatch";
import { requireGitHubConfig } from "@/lib/github/config";
import { getInstallationToken } from "@/lib/github/app";
import { latestRun } from "@/lib/github/scan";
import { getGame } from "@/lib/games";
import { requireUser } from "@/lib/supabase/server";
import type { WorkflowRow } from "@/lib/types";
import { CI_ACTION_META, isCiAction } from "@/lib/ci/actions";
import { unityBlockedReason } from "@/lib/ci/policy";
import { syncBuilds } from "@/lib/game-sync";
import type { ActionResult } from "../games/actions";

/**
 * Manually trigger a workflow that already exists in the repository.
 *  - Always runs on the repository's default branch (no arbitrary refs).
 *  - Requires `confirmed: true` from an explicit confirmation dialog.
 *  - Workflows that look like store publishing additionally require typing the game name.
 *  - Every attempt is written to the audit log.
 */
export async function triggerWorkflowAction(input: {
  workflowRowId: string;
  confirmed: boolean;
  typedGameName?: string;
  /** Shared-CI workflows only: one of the workflow's declared `action` choices. */
  action?: string;
}): Promise<ActionResult> {
  let audit: { game_id: string; game_name: string; workflow_path: string; workflow_kinds: string[]; ref: string; detail?: string } | null = null;
  const { supabase, user } = await requireUser();
  const log = async (outcome: "accepted" | "rejected", detail?: string) => {
    if (!audit) return;
    const { detail: _d, ...base } = audit;
    await supabase.from("workflow_dispatches").insert({ ...base, user_email: user.email ?? null, outcome, detail: detail?.slice(0, 500) ?? null });
  };

  try {
    if (input.confirmed !== true) throw new Error("Confirmation required.");

    const { data: wf, error } = await supabase.from("game_workflows").select("*").eq("id", input.workflowRowId).maybeSingle();
    if (error || !wf) throw new Error("Workflow not found.");
    const w = wf as WorkflowRow;
    const game = await getGame(supabase, w.game_id);
    if (!game) throw new Error("Game not found.");
    audit = { game_id: game.id, game_name: game.name, workflow_path: w.path, workflow_kinds: w.kinds, ref: game.default_branch };

    if (!w.dispatchable || w.github_workflow_id === null) throw new Error("This workflow cannot be triggered manually (no workflow_dispatch trigger, or it is disabled).");
    if (game.is_archived) throw new Error("The repository is archived.");

    let inputs: Record<string, string> | undefined;
    if (w.ci_ref) {
      // Shared studio CI: the only input the portal sends is `action`, validated against what the workflow declares.
      if (!isCiAction(input.action) || !w.ci_actions.includes(input.action)) throw new Error("Choose one of the actions this workflow supports.");
      if (CI_ACTION_META[input.action].typedConfirm && input.typedGameName?.trim() !== game.name) {
        throw new Error("This action prepares a release build. Type the game name to confirm.");
      }
      const blocked = unityBlockedReason(input.action);
      if (blocked) throw new Error(blocked);
      inputs = { action: input.action };
      audit.detail = `action=${input.action}`;
    } else {
      if (w.has_required_inputs) throw new Error("This workflow requires inputs, which the portal does not support for non-shared workflows. Run it from GitHub.");
      if (w.kinds.includes("publish") && input.typedGameName?.trim() !== game.name) {
        throw new Error("This workflow appears to publish to a store. Type the game name to confirm.");
      }
    }

    const cfg = requireGitHubConfig();
    await dispatchWorkflow(cfg, game.github_installation_id, game.owner, game.repo, w.github_workflow_id, game.default_branch, inputs);
    await log("accepted", audit.detail);

    // GitHub returns 204 without a run id; give it a moment, then pull the newest run.
    await new Promise((r) => setTimeout(r, 2500));
    try {
      const token = await getInstallationToken(cfg, game.github_installation_id);
      const run = await latestRun(token, `/repos/${game.owner}/${game.repo}`, w.github_workflow_id, game.default_branch);
      if (run) {
        await supabase.from("game_workflows").update({
          run_id: run.id, run_number: run.number, run_status: run.status, run_conclusion: run.conclusion,
          run_event: run.event, run_branch: run.branch, run_url: run.url, run_started_at: run.startedAt, run_updated_at: run.updatedAt,
        }).eq("id", w.id);
      }
    } catch {
      /* the dispatch itself succeeded; status refresh is best-effort */
    }
    if (w.ci_ref) await syncBuilds(supabase, game.id); // shows the new run (queued) immediately
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unexpected error";
    await log("rejected", message);
    return { ok: false, error: message };
  }
}
