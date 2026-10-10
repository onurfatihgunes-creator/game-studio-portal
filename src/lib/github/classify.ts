import { parse } from "yaml";
import type { Monetization, Platform, WorkflowKind } from "./types";

/**
 * Heuristic workflow classification from file contents. Pure functions, no network.
 * Every positive result records the signal that caused it, so the UI can show evidence.
 * When nothing matches we return empty lists — never a guess.
 */

export type Classification = {
  kinds: WorkflowKind[];
  platforms: Platform[];
  signals: string[];
  triggers: string[];
  hasWorkflowDispatch: boolean;
  hasRequiredInputs: boolean;
  name: string | null;
};

const TEST_SIGNALS: [RegExp, string][] = [
  [/game-ci\/unity-test-runner/i, "uses game-ci/unity-test-runner"],
  [/-runTests\b/, "Unity CLI -runTests"],
  [/\btestMode\s*:/i, "testMode input"],
];

const BUILD_SIGNALS: [RegExp, string][] = [
  [/game-ci\/unity-builder/i, "uses game-ci/unity-builder"],
  [/-buildTarget\b/, "Unity CLI -buildTarget"],
  [/\bbuildMethod\s*:|-executeMethod\b/i, "Unity build method"],
  [/\bgradlew?\s+(bundle|assemble)/i, "Gradle bundle/assemble"],
  [/\bxcodebuild\b/, "xcodebuild"],
  [/fastlane\s+(gym|build_app)/i, "fastlane gym"],
];

const PUBLISH_SIGNALS: [RegExp, string][] = [
  [/upload-google-play/i, "uses upload-google-play"],
  [/fastlane\s+(supply|pilot|deliver|upload_to_play_store|upload_to_testflight|beta|release)/i, "fastlane store upload"],
  [/upload-testflight-build|upload_to_testflight/i, "TestFlight upload"],
  [/xcrun\s+altool|notarytool|appstoreconnect/i, "App Store Connect upload"],
  [/androidpublisher|play[-_ ]?store/i, "Google Play publishing"],
];

const PLATFORM_KEYS = new Set(["targetplatform", "target_platform", "buildtarget", "build_target", "platform"]);

function platformFromString(s: string): Platform | null {
  const v = s.trim().toLowerCase();
  if (v === "android") return "android";
  if (v === "ios") return "ios";
  return null;
}

function collectPlatforms(node: unknown, out: Set<Platform>, underPlatformKey = false): void {
  if (typeof node === "string") {
    if (underPlatformKey) {
      const p = platformFromString(node);
      if (p) out.add(p);
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectPlatforms(item, out, underPlatformKey);
    return;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      collectPlatforms(v, out, underPlatformKey || PLATFORM_KEYS.has(k.toLowerCase()));
    }
  }
}

function normalizeTriggers(on: unknown): string[] {
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.filter((x): x is string => typeof x === "string");
  if (on && typeof on === "object") return Object.keys(on);
  return [];
}

export function classifyWorkflow(yamlText: string): Classification {
  const result: Classification = {
    kinds: [],
    platforms: [],
    signals: [],
    triggers: [],
    hasWorkflowDispatch: false,
    hasRequiredInputs: false,
    name: null,
  };

  let doc: unknown = null;
  try {
    doc = parse(yamlText);
  } catch {
    /* unparseable YAML: fall through to text signals only */
  }

  if (doc && typeof doc === "object") {
    const d = doc as Record<string, unknown>;
    if (typeof d.name === "string") result.name = d.name;
    // YAML 1.1 parsers may turn the bare key `on` into `true`; `yaml` (1.2) keeps "on".
    const on = d.on ?? (d as Record<string, unknown>)["true"];
    result.triggers = normalizeTriggers(on);
    result.hasWorkflowDispatch = result.triggers.includes("workflow_dispatch");
    if (on && typeof on === "object" && !Array.isArray(on)) {
      const wd = (on as Record<string, unknown>).workflow_dispatch;
      if (wd && typeof wd === "object") {
        const inputs = (wd as Record<string, unknown>).inputs;
        if (inputs && typeof inputs === "object") {
          result.hasRequiredInputs = Object.values(inputs).some(
            (i) => !!i && typeof i === "object" && (i as Record<string, unknown>).required === true &&
              (i as Record<string, unknown>).default === undefined,
          );
        }
      }
    }
  }

  const kinds = new Set<WorkflowKind>();
  const add = (kind: WorkflowKind, table: [RegExp, string][]) => {
    for (const [re, label] of table) {
      if (re.test(yamlText)) {
        kinds.add(kind);
        result.signals.push(`${kind}: ${label}`);
      }
    }
  };
  add("test", TEST_SIGNALS);
  add("build", BUILD_SIGNALS);
  add("publish", PUBLISH_SIGNALS);
  result.kinds = (["test", "build", "publish"] as const).filter((k) => kinds.has(k));

  const platforms = new Set<Platform>();
  if (doc) collectPlatforms(doc, platforms);
  for (const m of yamlText.matchAll(/-buildTarget\s+["']?(\w+)/g)) {
    const p = platformFromString(m[1]);
    if (p) platforms.add(p);
  }
  // Platforms only mean something for build/publish workflows.
  result.platforms = kinds.has("build") || kinds.has("publish") ? (["android", "ios"] as const).filter((p) => platforms.has(p)) : [];
  return result;
}

// ── Unity ───────────────────────────────────────────────────────────
export function parseUnityVersion(projectVersionTxt: string): string | null {
  const m = projectVersionTxt.match(/^m_EditorVersion:\s*(\S+)/m);
  return m ? m[1] : null;
}

// ── Monetization (package manifest) ─────────────────────────────────
export function detectMonetization(manifestJson: string | null): Monetization {
  if (manifestJson === null) return { checked: false };
  let manifest: { dependencies?: Record<string, string>; scopedRegistries?: { scopes?: string[] }[] };
  try {
    manifest = JSON.parse(manifestJson);
  } catch {
    return { checked: false };
  }
  const deps = Object.keys(manifest.dependencies ?? {}).map((d) => d.toLowerCase());
  const scopes = (manifest.scopedRegistries ?? []).flatMap((r) => r.scopes ?? []).map((s) => s.toLowerCase());
  const all = [...deps, ...scopes];
  const has = (needle: string) => all.some((d) => d.includes(needle));

  const other: string[] = [];
  if (has("levelplay") || has("ironsource")) other.push("Unity LevelPlay / ironSource");
  if (has("com.unity.ads") || has("unity.services.ads") || has("com.unity.monetization")) other.push("Unity Ads");
  if (has("applovin")) other.push("AppLovin");

  return {
    checked: true,
    admob: has("com.google.ads.mobile") || has("googlemobileads") || has("google-mobile-ads"),
    iap: has("com.unity.purchasing"),
    other_ads: other,
  };
}

// ── Docs ────────────────────────────────────────────────────────────
export function docKind(path: string): "readme" | "changelog" | "contributing" | "agent-guide" | "design" | "other" | null {
  const base = path.split("/").pop() ?? path;
  if (/^readme(\.|$)/i.test(base)) return "readme";
  if (/^changelog(\.|$)/i.test(base)) return "changelog";
  if (/^contributing(\.|$)/i.test(base)) return "contributing";
  if (/^(claude|agents)\.md$/i.test(base)) return "agent-guide";
  if (/^(gdd|design|game[-_ ]?design)[^/]*\.(md|pdf|docx?)$/i.test(base)) return "design";
  return null;
}
