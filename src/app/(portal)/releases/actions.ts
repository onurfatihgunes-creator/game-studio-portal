"use server";

import { revalidatePath } from "next/cache";
import { dispatchWorkflow } from "@/lib/github/dispatch";
import { requireGitHubConfig } from "@/lib/github/config";
import { getInstallationToken } from "@/lib/github/app";
import { latestRun } from "@/lib/github/scan";
import { getGame } from "@/lib/games";
import { requireUser } from "@/lib/supabase/server";
import type { WorkflowRow } from "@/lib/types";
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
}): Promise<ActionResult> {
  let audit: { game_id: string; game_name: string; workflow_path: string; workflow_kinds: string[]; ref: string } | null = null;
  const { supabase, user } = await requireUser();
  const log = async (outcome: "accepted" | "rejected", detail?: string) => {
    if (!audit) return;
    await supabase.from("workflow_dispatches").insert({ ...audit, user_email: user.email ?? null, outcome, detail: detail?.slice(0, 500) ?? null });
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
    if (w.has_required_inputs) throw new Error("This workflow requires inputs, which the portal does not support yet. Run it from GitHub.");
    if (game.is_archived) throw new Error("The repository is archived.");
    if (w.kinds.includes("publish") && input.typedGameName?.trim() !== game.name) {
      throw new Error("This workflow appears to publish to a store. Type the game name to confirm.");
    }

    const cfg = requireGitHubConfig();
    await dispatchWorkflow(cfg, game.github_installation_id, game.owner, game.repo, w.github_workflow_id, game.default_branch);
    await log("accepted");

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
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unexpected error";
    await log("rejected", message);
    return { ok: false, error: message };
  }
}
