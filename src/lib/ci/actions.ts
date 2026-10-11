/**
 * Vocabulary shared by the portal and the shared `unity-ci` workflows.
 * The caller workflow in each game exposes ONE dispatch input, `action`, whose choices are a subset of these.
 */
export const CI_ACTIONS = ["smoke", "test-editmode", "test-playmode", "android-dev", "android-release", "ios-validate"] as const;
export type CiAction = (typeof CI_ACTIONS)[number];
export type CiCategory = "test" | "android" | "ios" | "smoke";

export const CI_ACTION_META: Record<CiAction, { label: string; category: CiCategory; button: string; typedConfirm: boolean; note: string }> = {
  smoke: { label: "Pipeline self-test", category: "smoke", button: "Self-test", typedConfirm: false, note: "Runs no Unity. Verifies dispatch → run → result → portal." },
  "test-editmode": { label: "EditMode tests", category: "test", button: "Run EditMode tests", typedConfirm: false, note: "Unity batch mode on the build Mac." },
  "test-playmode": { label: "PlayMode tests", category: "test", button: "Run PlayMode tests", typedConfirm: false, note: "Unity batch mode on the build Mac (GPU)." },
  "android-dev": { label: "Android development APK", category: "android", button: "Build Android (dev)", typedConfirm: false, note: "Debug-signed APK. Sideload only." },
  "android-release": { label: "Android release AAB", category: "android", button: "Build Android release (AAB)", typedConfirm: true, note: "Signed with the upload key stored on the build Mac. Does NOT publish." },
  "ios-validate": { label: "iOS export + validation", category: "ios", button: "Validate iOS", typedConfirm: false, note: "Unity iOS export + unsigned xcodebuild. No signing, no upload." },
};

export const isCiAction = (v: unknown): v is CiAction => typeof v === "string" && (CI_ACTIONS as readonly string[]).includes(v);

/** Unknown / future actions in a workflow are ignored rather than trusted. */
export const knownActions = (list: string[]): CiAction[] => list.filter(isCiAction);

export function actionFromTitle(title: string | null | undefined): CiAction | null {
  const t = (title ?? "").trim();
  return isCiAction(t) ? t : null;
}
