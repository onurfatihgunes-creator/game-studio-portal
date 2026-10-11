import "server-only";
import { ghJson, ghSend, ghText, GitHubError } from "./app";

/**
 * The small slice of git hosting the advertising workflow needs: read files, list paths, find pull requests, make ONE commit on a
 * branch, open a pull request. Implemented over the GitHub REST API; tests use an in-memory fake. Never merges, never force-pushes,
 * never touches the default branch.
 */
export type PullRequest = { number: number; url: string; head: string; base: string; title: string; body: string; state: "open" | "closed"; merged: boolean };
export type FileChange = { path: string; /** null deletes the file */ content: string | null };

export interface RepoGit {
  readonly fullName: string;
  readonly defaultBranch: string;
  readFile(path: string, ref?: string): Promise<string | null>;
  /** All file paths at a ref. `complete` is false when GitHub truncated a very large tree. */
  listPaths(ref: string): Promise<{ paths: string[]; complete: boolean }>;
  openPullRequests(): Promise<PullRequest[]>;
  /** Pull requests whose head branch is `branch` in this repository (any state). */
  pullRequestsForBranch(branch: string): Promise<PullRequest[]>;
  branchExists(branch: string): Promise<boolean>;
  /** One commit on `branch`. Creates the branch from `createFrom` when it does not exist yet. Returns the commit sha. */
  commit(input: { branch: string; createFrom: string; message: string; files: FileChange[] }): Promise<string>;
  openPullRequest(input: { head: string; base: string; title: string; body: string }): Promise<PullRequest>;
  updatePullRequest(number: number, patch: { body?: string; title?: string }): Promise<void>;
}

type RawPr = { number: number; html_url: string; title: string; body: string | null; state: string; merged_at?: string | null; head: { ref: string; repo?: { full_name: string } | null }; base: { ref: string } };
const toPr = (r: RawPr): PullRequest => ({ number: r.number, url: r.html_url, head: r.head.ref, base: r.base.ref, title: r.title, body: r.body ?? "", state: r.state === "open" ? "open" : "closed", merged: !!r.merged_at });
const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");

export function githubRepoGit(token: string, owner: string, repo: string, defaultBranch: string): RepoGit {
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const fullName = `${owner}/${repo}`;
  const refSha = async (branch: string): Promise<string | null> => {
    const r = await ghJson<{ object: { sha: string } }>(token, `${base}/git/ref/heads/${enc(branch)}`, { allowNotFound: true });
    return r?.object.sha ?? null;
  };
  return {
    fullName,
    defaultBranch,
    readFile: (path, ref) => ghText(token, `${base}/contents/${enc(path)}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`),
    async listPaths(ref) {
      const t = await ghJson<{ tree: { path: string; type: string }[]; truncated: boolean }>(token, `${base}/git/trees/${encodeURIComponent(ref)}?recursive=1`, { allowNotFound: true });
      return { paths: (t?.tree ?? []).filter((e) => e.type === "blob").map((e) => e.path), complete: !t?.truncated };
    },
    async openPullRequests() {
      const out: PullRequest[] = [];
      for (let page = 1; page <= 5; page++) {
        const rows = (await ghJson<RawPr[]>(token, `${base}/pulls?state=open&per_page=100&page=${page}`)) ?? [];
        out.push(...rows.filter((r) => !r.head.repo || r.head.repo.full_name === fullName).map(toPr));
        if (rows.length < 100) break;
      }
      return out;
    },
    async pullRequestsForBranch(branch) {
      const rows = (await ghJson<RawPr[]>(token, `${base}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=20`)) ?? [];
      return rows.map(toPr);
    },
    async branchExists(branch) {
      return (await refSha(branch)) !== null;
    },
    async commit({ branch, createFrom, message, files }) {
      const existing = await refSha(branch);
      const parent = existing ?? (await refSha(createFrom));
      if (!parent) throw new GitHubError(`Branch ${createFrom} not found in ${fullName}`, 404, `${base}/git/ref/heads/${createFrom}`);
      const parentCommit = await ghJson<{ tree: { sha: string } }>(token, `${base}/git/commits/${parent}`);
      const tree = await ghSend<{ sha: string }>(token, "POST", `${base}/git/trees`, {
        base_tree: parentCommit!.tree.sha,
        tree: files.map((f) => (f.content === null ? { path: f.path, mode: "100644", type: "blob", sha: null } : { path: f.path, mode: "100644", type: "blob", content: f.content })),
      });
      const commit = await ghSend<{ sha: string }>(token, "POST", `${base}/git/commits`, {
        message, tree: tree.sha, parents: [parent],
        author: { name: "studio-ads", email: "studio-ads@users.noreply.github.com" },
      });
      if (existing) await ghSend(token, "PATCH", `${base}/git/refs/heads/${enc(branch)}`, { sha: commit.sha, force: false });
      else await ghSend(token, "POST", `${base}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
      return commit.sha;
    },
    async openPullRequest({ head, base: baseBranch, title, body }) {
      return toPr(await ghSend<RawPr>(token, "POST", `${base}/pulls`, { head, base: baseBranch, title, body, maintainer_can_modify: false }));
    },
    async updatePullRequest(number, patch) {
      await ghSend(token, "PATCH", `${base}/pulls/${number}`, patch);
    },
  };
}
