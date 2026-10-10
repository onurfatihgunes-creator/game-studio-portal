// Shared by server pages; kept out of the "use client" TriggerButton module.
export function triggerDisabledReason(w: { dispatchable: boolean; has_required_inputs: boolean; github_workflow_id: number | null; state: string | null }, archived: boolean): string | null {
  if (archived) return "Repository is archived";
  if (w.github_workflow_id === null) return "GitHub has not registered this workflow yet";
  if (w.state !== "active") return `Workflow is ${w.state ?? "unavailable"}`;
  if (!w.dispatchable) return "No workflow_dispatch trigger";
  if (w.has_required_inputs) return "Requires inputs — run from GitHub";
  return null;
}
