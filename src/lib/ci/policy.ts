import type { CiAction } from "./actions";

/**
 * Unity automation gate. Running Unity unattended on a build machine may require a specific Unity licence tier;
 * that is the studio's decision to confirm with Unity. Until the operator sets UNITY_AUTOMATION_ALLOWED=true
 * on the server, every Unity action is refused (server-side, regardless of what the browser sends).
 * The pipeline self-test never runs Unity and is always allowed.
 */
export const unityAutomationAllowed = (): boolean => process.env.UNITY_AUTOMATION_ALLOWED === "true";

export const UNITY_BLOCK_MESSAGE =
  "Blocked: automated Unity builds are switched off until the Unity licence question is resolved. Set UNITY_AUTOMATION_ALLOWED=true on the server to enable them. The Self-test action is not affected.";

export function unityBlockedReason(action: CiAction | string | undefined): string | null {
  if (action === "smoke") return null;
  return unityAutomationAllowed() ? null : UNITY_BLOCK_MESSAGE;
}
