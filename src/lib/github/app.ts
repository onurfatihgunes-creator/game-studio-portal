import "server-only";
import { createPrivateKey, createSign } from "node:crypto";

/**
 * GitHub App authentication. Credentials live in server env only.
 * Flow: sign a short-lived App JWT → exchange it for a per-installation token
 * (1 h, scoped to the repos the owner installed the app on) → call the REST API.
 */

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

export type GitHubConfig = { appId: string; slug: string | null; privateKey: string };

export function readGitHubConfig(): { ok: true; config: GitHubConfig } | { ok: false; missing: string[] } {
  const appId = process.env.GITHUB_APP_ID?.trim();
  const raw = process.env.GITHUB_APP_PRIVATE_KEY?.trim();
  const missing: string[] = [];
  if (!appId) missing.push("GITHUB_APP_ID");
  if (!raw) missing.push("GITHUB_APP_PRIVATE_KEY");
  if (missing.length || !appId || !raw) return { ok: false, missing };
  return {
    ok: true,
    config: { appId, slug: process.env.GITHUB_APP_SLUG?.trim() || null, privateKey: normalizePrivateKey(raw) },
  };
}

/** Accepts a PEM with real newlines, a PEM with literal "\n", or the PEM base64-encoded. */
export function normalizePrivateKey(raw: string): string {
  let key = raw;
  if (!key.includes("BEGIN")) {
    key = Buffer.from(key, "base64").toString("utf8");
  }
  return key.replace(/\\n/g, "\n");
}

const b64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");

export function createAppJwt(config: GitHubConfig, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  // iat 60 s in the past tolerates clock drift; GitHub allows at most 10 min lifetime.
  const payload = b64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 9 * 60, iss: config.appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(createPrivateKey(config.privateKey)).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

const API = (process.env.GITHUB_API_URL?.trim() || "https://api.github.com").replace(/\/$/, ""); // override for GitHub Enterprise Server / tests

export async function githubFetch(
  token: string,
  path: string,
  init: RequestInit & { raw?: boolean } = {},
): Promise<Response> {
  const { raw, ...rest } = init;
  const res = await fetch(`${API}${path}`, {
    ...rest,
    cache: "no-store",
    headers: {
      Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "game-studio-portal",
      ...(rest.headers ?? {}),
    },
  });
  return res;
}

async function explain(res: Response, path: string): Promise<GitHubError> {
  let detail = "";
  try {
    const body = (await res.json()) as { message?: string };
    detail = body.message ?? "";
  } catch {
    /* body not JSON */
  }
  const hint =
    res.status === 401
      ? " (check GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY)"
      : res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0"
        ? " (GitHub rate limit reached)"
        : res.status === 403
          ? " (the GitHub App lacks a required permission)"
          : "";
  return new GitHubError(`GitHub ${res.status} on ${path}: ${detail || res.statusText}${hint}`, res.status, path);
}

/** JSON GET. Returns null on 404 when allowNotFound is set. */
export async function ghJson<T>(token: string, path: string, opts: { allowNotFound?: boolean } = {}): Promise<T | null> {
  const res = await githubFetch(token, path);
  if (res.status === 404 && opts.allowNotFound) return null;
  if (!res.ok) throw await explain(res, path);
  return (await res.json()) as T;
}

export async function ghText(token: string, path: string): Promise<string | null> {
  const res = await githubFetch(token, path, { raw: true });
  if (res.status === 404) return null;
  if (!res.ok) throw await explain(res, path);
  return await res.text();
}

export async function ghPostNoContent(token: string, path: string, body: unknown): Promise<void> {
  const res = await githubFetch(token, path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) throw await explain(res, path);
}

// ── tokens ──────────────────────────────────────────────────────────
const tokenCache = new Map<number, { token: string; expiresAt: number }>();

export async function getInstallationToken(config: GitHubConfig, installationId: number): Promise<string> {
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt - Date.now() > 60_000) return cached.token;

  const path = `/app/installations/${installationId}/access_tokens`;
  const res = await githubFetch(createAppJwt(config), path, { method: "POST" });
  if (!res.ok) throw await explain(res, path);
  const body = (await res.json()) as { token: string; expires_at: string };
  tokenCache.set(installationId, { token: body.token, expiresAt: Date.parse(body.expires_at) });
  return body.token;
}

export type Installation = { id: number; account: string; accountType: string; repositorySelection: string };

export async function listInstallations(config: GitHubConfig): Promise<Installation[]> {
  const jwt = createAppJwt(config);
  const rows = await ghJson<
    { id: number; account: { login: string; type: string } | null; repository_selection: string }[]
  >(jwt, "/app/installations?per_page=100");
  return (rows ?? []).map((r) => ({
    id: r.id,
    account: r.account?.login ?? "unknown",
    accountType: r.account?.type ?? "unknown",
    repositorySelection: r.repository_selection,
  }));
}

export type RepoSummary = {
  id: number;
  installationId: number;
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  archived: boolean;
  pushedAt: string | null;
  description: string | null;
};

type RawRepo = {
  id: number;
  full_name: string;
  name: string;
  owner: { login: string };
  private: boolean;
  archived: boolean;
  pushed_at: string | null;
  description: string | null;
};

export async function listInstallationRepos(config: GitHubConfig, installationId: number): Promise<RepoSummary[]> {
  const token = await getInstallationToken(config, installationId);
  const out: RepoSummary[] = [];
  for (let page = 1; page <= 10; page++) {
    const body = await ghJson<{ repositories: RawRepo[] }>(
      token,
      `/installation/repositories?per_page=100&page=${page}`,
    );
    const repos = body?.repositories ?? [];
    for (const r of repos) {
      out.push({
        id: r.id,
        installationId,
        fullName: r.full_name,
        owner: r.owner.login,
        name: r.name,
        private: r.private,
        archived: r.archived,
        pushedAt: r.pushed_at,
        description: r.description,
      });
    }
    if (repos.length < 100) break;
  }
  return out;
}

export async function listAllAccessibleRepos(config: GitHubConfig): Promise<RepoSummary[]> {
  const installs = await listInstallations(config);
  const lists = await Promise.all(installs.map((i) => listInstallationRepos(config, i.id)));
  return lists.flat().sort((a, b) => a.fullName.localeCompare(b.fullName));
}
