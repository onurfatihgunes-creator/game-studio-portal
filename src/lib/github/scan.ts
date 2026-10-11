import "server-only";
import {
  type GitHubConfig,
  getInstallationToken,
  ghJson,
  ghText,
} from "./app";
import { parseProjectSettings } from "./project-facts";
import { detectMonetization, docKind, parseUnityVersion } from "./classify";
import { CONFIG_PATH, detectStudioAds, MODULE_PACKAGE } from "@/lib/ads/integration";
import type { DocEntry, Monetization, ScanResult } from "./types";

type RawRepo = {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string };
  html_url: string;
  description: string | null;
  default_branch: string;
  private: boolean;
  archived: boolean;
  pushed_at: string | null;
};
type DirEntry = { name: string; path: string; type: string };

const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");
const DOC_DIRS = new Set(["docs", "doc", "documentation"]);

/**
 * Scan one repository through the GitHub API.
 * The first call (GET /repos/{owner}/{repo}) is the connection proof: if it throws,
 * nothing else runs and the caller must not create a game record.
 * Everything we cannot confirm is left empty/null — callers render that as "Not configured".
 */
export async function scanRepository(
  config: GitHubConfig,
  installationId: number,
  owner: string,
  name: string,
): Promise<ScanResult> {
  const token = await getInstallationToken(config, installationId);
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;

  const raw = await ghJson<RawRepo>(token, base);
  if (!raw) throw new Error(`Repository ${owner}/${name} not found`);
  const branch = raw.default_branch;

  const [commits, rootEntries] = await Promise.all([
    ghJson<
      { sha: string; html_url: string; commit: { message: string; author: { name?: string; date?: string } | null } }[]
    >(token, `${base}/commits?per_page=1&sha=${encodeURIComponent(branch)}`, { allowNotFound: true }).catch((e) => {
      // 409 = empty repository
      if ((e as { status?: number }).status === 409) return null;
      throw e;
    }),
    ghJson<DirEntry[]>(token, `${base}/contents/`, { allowNotFound: true }).catch((e) => {
      if ((e as { status?: number }).status === 404) return null;
      throw e;
    }),
  ]);

  const root = Array.isArray(rootEntries) ? rootEntries : [];
  const latestCommit = commits?.[0]
    ? {
        sha: commits[0].sha,
        message: commits[0].commit.message.split("\n")[0].slice(0, 300),
        author: commits[0].commit.author?.name ?? null,
        date: commits[0].commit.author?.date ?? null,
        url: commits[0].html_url,
      }
    : null;

  // ── Unity ─────────────────────────────────────────────────────────
  const unity = await detectUnity(token, base, branch, root);

  // ── Documentation ─────────────────────────────────────────────────
  const docs = await detectDocs(token, base, root);

  // ── Monetization SDKs ─────────────────────────────────────────────
  const prefix = unity.projectPath ? unity.projectPath + "/" : "";
  const manifestText = unity.detected ? await ghText(token, `${base}/contents/${enc(`${prefix}Packages/manifest.json`)}`) : null;
  const monetization: Monetization = unity.detected ? detectMonetization(manifestText) : { checked: false };
  if (unity.detected && monetization.checked) {
    const [packageJson, configJson] = await Promise.all([
      ghText(token, `${base}/contents/${enc(`${prefix}Packages/${MODULE_PACKAGE}/package.json`)}`),
      ghText(token, `${base}/contents/${enc(`${prefix}${CONFIG_PATH}`)}`),
    ]);
    monetization.studio_ads = detectStudioAds({ packageJson, manifest: manifestText, configJson });
  }

  // ── Project facts (versions, bundle ids, signing flags) ───────────
  const projectFacts = unity.detected
    ? parseProjectSettings(await ghText(token, `${base}/contents/${enc(`${unity.projectPath ? unity.projectPath + "/" : ""}ProjectSettings/ProjectSettings.asset`)}`))
    : parseProjectSettings(null);

  return {
    scannedAt: new Date().toISOString(),
    repo: {
      id: raw.id,
      installationId,
      owner: raw.owner.login,
      name: raw.name,
      fullName: raw.full_name,
      htmlUrl: raw.html_url,
      description: raw.description,
      defaultBranch: branch,
      isPrivate: raw.private,
      isArchived: raw.archived,
      pushedAt: raw.pushed_at,
    },
    latestCommit,
    unity,
    docs,
    monetization,
    projectFacts,
  };
}

async function detectUnity(token: string, base: string, branch: string, root: DirEntry[]): Promise<ScanResult["unity"]> {
  const versionFile = async (dir: string) => {
    const txt = await ghText(token, `${base}/contents/${enc((dir ? dir + "/" : "") + "ProjectSettings/ProjectVersion.txt")}`);
    return txt === null ? null : parseUnityVersion(txt);
  };

  if (root.some((e) => e.name === "ProjectSettings" && e.type === "dir")) {
    const version = await versionFile("");
    return { detected: true, version, projectPath: "", note: version ? null : "ProjectVersion.txt present but version unreadable" };
  }

  // Not at the root: look for a nested project (monorepo). The recursive tree can be huge, so only on demand.
  const tree = await ghJson<{ tree: { path: string; type: string }[]; truncated: boolean }>(
    token,
    `${base}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    { allowNotFound: true },
  ).catch((e) => {
    if ((e as { status?: number }).status === 409) return null;
    throw e;
  });
  const hits = (tree?.tree ?? [])
    .map((t) => t.path)
    .filter((p) => p === "ProjectSettings/ProjectVersion.txt" || p.endsWith("/ProjectSettings/ProjectVersion.txt"))
    .map((p) => p.slice(0, -"/ProjectSettings/ProjectVersion.txt".length))
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));

  if (hits.length) {
    const dir = hits[0];
    const version = await versionFile(dir);
    return {
      detected: true,
      version,
      projectPath: dir,
      note: hits.length > 1 ? `${hits.length} Unity projects found; using "${dir}"` : null,
    };
  }
  return {
    detected: false,
    version: null,
    projectPath: null,
    note: tree?.truncated ? "Repository tree too large to search; only the repo root was checked" : null,
  };
}

async function detectDocs(token: string, base: string, root: DirEntry[]): Promise<DocEntry[]> {
  const docs: DocEntry[] = [];
  for (const e of root) {
    if (e.type !== "file") continue;
    const kind = docKind(e.path);
    if (kind) docs.push({ path: e.path, kind });
  }
  const dir = root.find((e) => e.type === "dir" && DOC_DIRS.has(e.name.toLowerCase()));
  if (dir) {
    const entries = (await ghJson<DirEntry[]>(token, `${base}/contents/${enc(dir.path)}`, { allowNotFound: true })) ?? [];
    for (const e of entries.slice(0, 50)) {
      if (e.type === "file" && /\.(md|mdx|pdf|txt|docx?)$/i.test(e.name)) docs.push({ path: e.path, kind: "docs-folder" });
    }
  }
  return docs;
}

/**
 * Cheap discovery probe for bulk import: one API call, no writes.
 * True when the repo root has a ProjectSettings directory (same rule the full scan uses first).
 * Nested Unity projects are not found here; the full scan at import time still handles them.
 */
export async function quickUnityCheck(config: GitHubConfig, installationId: number, owner: string, name: string): Promise<boolean> {
  const token = await getInstallationToken(config, installationId);
  const root = await ghJson<DirEntry[]>(
    token,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/`,
    { allowNotFound: true },
  ).catch((e) => {
    if ((e as { status?: number }).status === 404) return null;
    throw e;
  });
  return Array.isArray(root) && root.some((e) => e.name === "ProjectSettings" && e.type === "dir");
}
