/**
 * Facts read from Unity's ProjectSettings/ProjectSettings.asset (plain text YAML).
 * Pure parsing, no network. Missing values stay null — never guessed.
 * Unity's file is a multi-document YAML with custom tags, so we use a small indentation-aware reader
 * instead of a YAML parser.
 */
export type ProjectFacts = {
  checked: boolean;
  companyName?: string | null;
  productName?: string | null;
  version?: string | null;               // bundleVersion
  androidBundleId?: string | null;
  iosBundleId?: string | null;
  androidVersionCode?: number | null;
  iosBuildNumber?: string | null;
  androidMinSdk?: number | null;
  androidTargetSdk?: number | null;      // 0 = "highest installed" (auto)
  androidCustomKeystore?: boolean | null;
  androidScriptingBackend?: "mono" | "il2cpp" | null;
  iosScriptingBackend?: "mono" | "il2cpp" | null;
  iosMinOs?: string | null;
  appleTeamId?: string | null;
};

function scalar(text: string, key: string): string | null {
  const m = text.match(new RegExp(`^  ${key}:[ \\t]*(.*)$`, "m"));
  if (!m) return null;
  const v = m[1].trim();
  return v === "" ? "" : v.replace(/^['"]|['"]$/g, "");
}

/** Reads `  key:` followed by children indented by 4 spaces (`    Name: value`). */
function map(text: string, key: string): Record<string, string> {
  const lines = text.split("\n");
  const out: Record<string, string> = {};
  const start = lines.findIndex((l) => l === `  ${key}:`);
  if (start < 0) return out;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^ {4}([^:\s][^:]*):[ \t]*(.*)$/);
    if (!m) break;
    out[m[1].trim()] = m[2].trim();
  }
  return out;
}

const int = (v: string | null) => (v !== null && /^-?\d+$/.test(v) ? Number(v) : null);
const backend = (v: string | undefined): "mono" | "il2cpp" | null => (v === "1" ? "il2cpp" : v === "0" ? "mono" : null);

export function parseProjectSettings(text: string | null): ProjectFacts {
  if (!text || !/^PlayerSettings:/m.test(text)) return { checked: false };
  const ids = map(text, "applicationIdentifier");
  const builds = map(text, "buildNumber");
  const backends = map(text, "scriptingBackend");
  const blank = (v: string | null | undefined) => (v === undefined || v === null || v === "" ? null : v);
  return {
    checked: true,
    companyName: blank(scalar(text, "companyName")),
    productName: blank(scalar(text, "productName")),
    version: blank(scalar(text, "bundleVersion")),
    androidBundleId: blank(ids.Android),
    iosBundleId: blank(ids.iPhone),
    androidVersionCode: int(scalar(text, "AndroidBundleVersionCode")),
    iosBuildNumber: blank(builds.iPhone),
    androidMinSdk: int(scalar(text, "AndroidMinSdkVersion")),
    androidTargetSdk: int(scalar(text, "AndroidTargetSdkVersion")),
    androidCustomKeystore: scalar(text, "androidUseCustomKeystore") === null ? null : scalar(text, "androidUseCustomKeystore") === "1",
    androidScriptingBackend: backend(backends.Android),
    iosScriptingBackend: backend(backends.iPhone),
    iosMinOs: blank(scalar(text, "iOSTargetOSVersionString")),
    appleTeamId: blank(scalar(text, "appleDeveloperTeamID")),
  };
}
