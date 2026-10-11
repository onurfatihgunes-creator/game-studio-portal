import { type AdsConfig, validateConfig } from "../ads/config";
import type { BuildRunRow, GameRow, ReleaseRow } from "../types";

/**
 * Release readiness: pure functions over stored facts (repo scan + real CI runs). Every check is
 * pass / fail / warn / unknown with its evidence. "unknown" means no data — never silently "pass".
 * Readiness never publishes anything; it only decides whether a candidate may be APPROVED by a person.
 */
export type CheckState = "pass" | "fail" | "warn" | "unknown";
export type Check = { id: string; label: string; state: CheckState; detail: string };
export type Readiness = { platform: "android" | "ios"; checks: Check[]; blockers: number; warnings: number; unknowns: number };

const completed = (r: BuildRunRow) => r.status === "completed";
const ok = (r: BuildRunRow) => completed(r) && r.conclusion === "success";
const newest = (rs: BuildRunRow[]) => [...rs].sort((a, b) => Date.parse(b.started_at ?? "0") - Date.parse(a.started_at ?? "0"))[0];
const short = (s: string | null) => (s ? s.slice(0, 7) : "unknown");

const PLACEHOLDER_ID = /(^|\.)(defaultcompany|company|yourcompany|example|test|unity)(\.|$)/i;

export function isPlaceholderId(id: string | null | undefined): boolean {
  if (!id) return false;
  return PLACEHOLDER_ID.test(id) || /^com\.company\.product$/i.test(id);
}

function latestOf(runs: BuildRunRow[], actions: string[]) {
  return newest(runs.filter((r) => r.action && actions.includes(r.action) && completed(r)));
}

function testsCheck(game: GameRow, runs: BuildRunRow[]): Check {
  const modes = ["test-editmode", "test-playmode"].map((a) => ({ a, run: latestOf(runs, [a]) })).filter((m) => m.run);
  if (modes.length === 0) return { id: "tests", label: "Tests pass on the latest commit", state: "unknown", detail: "No test run recorded. Run EditMode/PlayMode tests from the portal." };
  const failing = modes.find((m) => !ok(m.run!));
  if (failing) return { id: "tests", label: "Tests pass on the latest commit", state: "fail", detail: `${failing.a} last run: ${failing.run!.conclusion} (commit ${short(failing.run!.head_sha)}).` };
  const stale = modes.filter((m) => game.commit_sha && m.run!.head_sha !== game.commit_sha);
  if (stale.length) return { id: "tests", label: "Tests pass on the latest commit", state: "warn", detail: `Passed, but on an older commit (${short(stale[0].run!.head_sha)}; latest is ${short(game.commit_sha)}). Re-run.` };
  return { id: "tests", label: "Tests pass on the latest commit", state: "pass", detail: `${modes.map((m) => m.a.replace("test-", "")).join(" + ")} passed on ${short(game.commit_sha)}.` };
}

const repoCheck = (game: GameRow): Check =>
  game.is_archived
    ? { id: "repo", label: "Repository is active", state: "fail", detail: "The repository is archived." }
    : { id: "repo", label: "Repository is active", state: "pass", detail: "Not archived." };

/** `undefined` = caller did not load ads (no check); `null` = loaded, none recorded. */
function adsCheck(ads: AdsConfig | null | undefined, platform: "android" | "ios"): Check | null {
  if (ads === undefined) return null;
  const label = "Advertising configuration is safe to ship";
  if (ads === null) return { id: "ads", label, state: "unknown", detail: "No advertising configuration recorded (fine if this game ships without ads)." };
  if (!ads.enabled) return { id: "ads", label, state: "pass", detail: "Ads are disabled for this game." };
  const errors = validateConfig(ads).filter((p) => p.level === "error");
  if (errors.length) return { id: "ads", label, state: "fail", detail: errors[0].message };
  if (ads.test_mode) return { id: "ads", label, state: "fail", detail: "Ads are enabled in TEST mode: a release would show demo ads and earn nothing. Turn test mode off with real IDs, or disable ads." };
  const ids = ads[platform];
  if (!ids.app_id) return { id: "ads", label, state: "fail", detail: `Ads are enabled but there is no ${platform} AdMob app ID.` };
  return { id: "ads", label, state: "pass", detail: `Production ad IDs configured for ${platform}.` };
}

function identityCheck(game: GameRow, platform: "android" | "ios"): Check {
  const f = game.project_facts;
  const label = "Bundle identifier and company are set (not placeholders)";
  if (!f?.checked) return { id: "identity", label, state: "unknown", detail: "ProjectSettings could not be read." };
  const id = platform === "android" ? f.androidBundleId : f.iosBundleId;
  if (!id) return { id: "identity", label, state: "fail", detail: `No ${platform === "android" ? "Android" : "iOS"} bundle identifier is set.` };
  if (isPlaceholderId(id) || /^defaultcompany$/i.test(f.companyName ?? "")) {
    return { id: "identity", label, state: "fail", detail: `${isPlaceholderId(id) ? `Bundle id "${id}"` : `Company name "${f.companyName}"`} looks like a Unity default.` };
  }
  return { id: "identity", label, state: "pass", detail: `${id}${f.companyName ? ` · company "${f.companyName}"` : ""}.` };
}

function versionCheck(game: GameRow, platform: "android" | "ios", run: BuildRunRow | undefined, releases: ReleaseRow[]): Check {
  const f = game.project_facts;
  const label = "Version and build number are newer than the last approved release";
  const version = run?.version ?? f?.version ?? null;
  const code = run?.build_number ?? (platform === "android" ? f?.androidVersionCode ?? null : f?.iosBuildNumber != null && /^\d+$/.test(f.iosBuildNumber) ? Number(f.iosBuildNumber) : null);
  if (!version || code === null) return { id: "version", label, state: "unknown", detail: "Version or build number could not be determined." };
  const prior = releases.filter((r) => r.platform === platform && (r.status === "approved" || r.status === "published_manually")).sort((a, b) => b.build_number - a.build_number)[0];
  if (prior && code <= prior.build_number) return { id: "version", label, state: "fail", detail: `Build number ${code} is not above the last approved ${prior.build_number} (v${prior.version}).` };
  return { id: "version", label, state: "pass", detail: `v${version} (${code})${prior ? ` > last approved ${prior.build_number}` : " — first release recorded"}.` };
}

export function evaluateAndroid(game: GameRow, runs: BuildRunRow[], releases: ReleaseRow[], candidateRun?: BuildRunRow, ads?: AdsConfig | null): Readiness {
  const f = game.project_facts;
  const build = candidateRun ?? latestOf(runs, ["android-release", "android-dev"]);
  const checks: Check[] = [repoCheck(game), testsCheck(game, runs)];

  if (!build) checks.push({ id: "build", label: "Android build exists for the latest commit", state: "unknown", detail: "No Android build recorded." });
  else if (!ok(build)) checks.push({ id: "build", label: "Android build exists for the latest commit", state: "fail", detail: `${build.action}: ${build.conclusion ?? build.status} (commit ${short(build.head_sha)})${build.failed_step ? `, failed at “${build.failed_step}”` : ""}.` });
  else if (game.commit_sha && build.head_sha !== game.commit_sha) checks.push({ id: "build", label: "Android build exists for the latest commit", state: "warn", detail: `Built from ${short(build.head_sha)}, latest commit is ${short(game.commit_sha)}.` });
  else checks.push({ id: "build", label: "Android build exists for the latest commit", state: "pass", detail: `${build.action} succeeded on ${short(build.head_sha)}.` });

  const art = build?.artifacts.find((a) => !a.expired);
  checks.push(!build || !ok(build)
    ? { id: "artifact", label: "Downloadable artifact is available", state: "unknown", detail: "No successful build." }
    : art ? { id: "artifact", label: "Downloadable artifact is available", state: "pass", detail: `${art.name} (${(art.size_bytes / 1048576).toFixed(1)} MB).` }
          : { id: "artifact", label: "Downloadable artifact is available", state: "fail", detail: "The artifact expired or was not uploaded. Rebuild." });

  checks.push(!build || !ok(build)
    ? { id: "signing", label: "Build is a release-signed AAB (not a debug APK)", state: "unknown", detail: "No successful build." }
    : build.action === "android-release"
      ? { id: "signing", label: "Build is a release-signed AAB (not a debug APK)", state: "pass", detail: "Produced by android-release with the upload key from the build machine." }
      : { id: "signing", label: "Build is a release-signed AAB (not a debug APK)", state: "fail", detail: "This is a development build signed with Unity's debug key; Google Play rejects it." });

  checks.push(identityCheck(game, "android"));
  checks.push(versionCheck(game, "android", build, releases));
  checks.push(!f?.checked
    ? { id: "target-api", label: "Target API level is set explicitly", state: "unknown", detail: "ProjectSettings could not be read." }
    : f.androidTargetSdk && f.androidTargetSdk > 0
      ? { id: "target-api", label: "Target API level is set explicitly", state: "pass", detail: `Target API ${f.androidTargetSdk}. Confirm it meets Google Play's current minimum.` }
      : { id: "target-api", label: "Target API level is set explicitly", state: "warn", detail: "Set to “automatic” (highest installed). Pin it and confirm Google Play's current minimum." });
  const a = adsCheck(ads, "android"); if (a) checks.push(a);
  return tally("android", checks);
}

export function evaluateIos(game: GameRow, runs: BuildRunRow[], releases: ReleaseRow[], candidateRun?: BuildRunRow, ads?: AdsConfig | null): Readiness {
  const f = game.project_facts;
  const val = candidateRun ?? latestOf(runs, ["ios-validate"]);
  const checks: Check[] = [repoCheck(game), testsCheck(game, runs)];
  if (!val) checks.push({ id: "validate", label: "iOS export compiles (unsigned xcodebuild)", state: "unknown", detail: "No iOS validation recorded." });
  else if (!ok(val)) checks.push({ id: "validate", label: "iOS export compiles (unsigned xcodebuild)", state: "fail", detail: `ios-validate: ${val.conclusion ?? val.status}${val.failed_step ? `, failed at “${val.failed_step}”` : ""}.` });
  else if (game.commit_sha && val.head_sha !== game.commit_sha) checks.push({ id: "validate", label: "iOS export compiles (unsigned xcodebuild)", state: "warn", detail: `Validated ${short(val.head_sha)}, latest is ${short(game.commit_sha)}.` });
  else checks.push({ id: "validate", label: "iOS export compiles (unsigned xcodebuild)", state: "pass", detail: `ios-validate succeeded on ${short(val.head_sha)}.` });
  checks.push(identityCheck(game, "ios"));
  checks.push(versionCheck(game, "ios", val, releases));
  checks.push(!f?.checked
    ? { id: "team", label: "Apple signing is set up", state: "unknown", detail: "ProjectSettings could not be read." }
    : f.appleTeamId ? { id: "team", label: "Apple signing is set up", state: "pass", detail: `Team id ${f.appleTeamId} in the project.` }
                    : { id: "team", label: "Apple signing is set up", state: "warn", detail: "No Apple team id in the project. IPA export/signing is outside this phase; configure it on the build Mac." });
  const a = adsCheck(ads, "ios"); if (a) checks.push(a);
  return tally("ios", checks);
}

function tally(platform: "android" | "ios", checks: Check[]): Readiness {
  const n = (s: CheckState) => checks.filter((c) => c.state === s).length;
  return { platform, checks, blockers: n("fail"), warnings: n("warn"), unknowns: n("unknown") };
}

/** A person may APPROVE a candidate only when no check fails (warnings/unknowns are shown to them). */
export const canApprove = (r: Readiness) => r.blockers === 0;
