import { generateKeyPairSync, createVerify } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createAppJwt, listAllAccessibleRepos, normalizePrivateKey } from "@/lib/github/app";
import { scanRepository } from "@/lib/github/scan";

let pem: string;
let publicPem: string;
beforeAll(() => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
});
afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Minimal in-memory GitHub: path → handler. */
function fakeGitHub(files: Record<string, string>, opts: { repoStatus?: number } = {}) {
  const calls: string[] = [];
  const handler = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const p = url.pathname;
    calls.push(`${init?.method ?? "GET"} ${p}${url.search}`);
    const auth = new Headers(init?.headers).get("authorization");
    if (!auth?.startsWith("Bearer ")) return json({ message: "Bad credentials" }, 401);

    if (p === "/app/installations") return json([{ id: 7, account: { login: "studio", type: "Organization" }, repository_selection: "selected" }]);
    if (p === "/app/installations/7/access_tokens") return json({ token: "inst-token", expires_at: new Date(Date.now() + 3600_000).toISOString() });
    if (p === "/installation/repositories") return json({ repositories: [{ id: 1, full_name: "studio/mini-one", name: "mini-one", owner: { login: "studio" }, private: true, archived: false, pushed_at: null, description: null }] });
    if (p === "/repos/studio/mini-one") {
      if (opts.repoStatus) return json({ message: "Not Found" }, opts.repoStatus);
      return json({ id: 1, name: "mini-one", full_name: "studio/mini-one", owner: { login: "studio" }, html_url: "https://github.com/studio/mini-one", description: "d", default_branch: "main", private: true, archived: false, pushed_at: "2026-01-01T00:00:00Z" });
    }
    if (p === "/repos/studio/mini-one/commits") return json([{ sha: "abcdef1234567", html_url: "https://x/c", commit: { message: "Fix level 3\n\nbody", author: { name: "Dev", date: "2026-01-01T00:00:00Z" } } }]);
    if (p === "/repos/studio/mini-one/contents/") return json([
      { name: "Assets", path: "Assets", type: "dir" }, { name: "ProjectSettings", path: "ProjectSettings", type: "dir" },
      { name: "README.md", path: "README.md", type: "file" }, { name: "docs", path: "docs", type: "dir" },
    ]);
    if (p === "/repos/studio/mini-one/contents/docs") return json([{ name: "gdd.md", path: "docs/gdd.md", type: "file" }]);
    if (p === "/repos/studio/mini-one/contents/.github/workflows") return json([
      { name: "build.yml", path: ".github/workflows/build.yml", type: "file" },
      { name: "notes.txt", path: ".github/workflows/notes.txt", type: "file" },
    ]);
    if (p === "/repos/studio/mini-one/actions/workflows") return json({ workflows: [{ id: 99, name: "Build", path: ".github/workflows/build.yml", state: "active" }] });
    if (p === "/repos/studio/mini-one/actions/workflows/99/runs") {
      return json({ workflow_runs: [{ id: 5, run_number: 12, status: "completed", conclusion: "success", event: "push", head_branch: "main", html_url: "https://x/run/5", run_started_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:10:00Z" }] });
    }
    const file = decodeURIComponent(p.replace("/repos/studio/mini-one/contents/", ""));
    if (files[file] !== undefined) return new Response(files[file], { status: 200 });
    return json({ message: "Not Found" }, 404);
  };
  vi.stubGlobal("fetch", vi.fn(handler));
  return calls;
}

const config = () => ({ appId: "42", slug: "portal", privateKey: pem });

describe("GitHub App auth", () => {
  it("signs a verifiable RS256 JWT", () => {
    const jwt = createAppJwt(config(), 1_000_000);
    const [h, p, s] = jwt.split(".");
    const v = createVerify("RSA-SHA256");
    v.update(`${h}.${p}`);
    expect(v.verify(publicPem, Buffer.from(s, "base64url"))).toBe(true);
    const payload = JSON.parse(Buffer.from(p, "base64url").toString());
    expect(payload).toMatchObject({ iss: "42", iat: 1_000_000 - 60 });
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(600);
  });

  it("accepts PEM with escaped newlines or base64", () => {
    expect(normalizePrivateKey(pem.replace(/\n/g, "\\n"))).toBe(pem);
    expect(normalizePrivateKey(Buffer.from(pem).toString("base64"))).toBe(pem);
  });

  it("lists repositories across installations", async () => {
    fakeGitHub({});
    const repos = await listAllAccessibleRepos(config());
    expect(repos.map((r) => r.fullName)).toEqual(["studio/mini-one"]);
    expect(repos[0].installationId).toBe(7);
  });
});

describe("scanRepository", () => {
  it("normalizes a Unity repo from real-shaped API responses", async () => {
    const calls = fakeGitHub({
      "ProjectSettings/ProjectVersion.txt": "m_EditorVersion: 6000.0.23f1\n",
      "Packages/manifest.json": JSON.stringify({ dependencies: { "com.unity.purchasing": "4.9.0" } }),
      ".github/workflows/build.yml": "name: Build\non: [workflow_dispatch]\njobs:\n  b:\n    steps:\n      - uses: game-ci/unity-builder@v4\n        with:\n          targetPlatform: Android\n",
    });
    const scan = await scanRepository(config(), 7, "studio", "mini-one");
    expect(scan.repo).toMatchObject({ id: 1, fullName: "studio/mini-one", defaultBranch: "main", isPrivate: true });
    expect(scan.latestCommit).toMatchObject({ sha: "abcdef1234567", message: "Fix level 3", author: "Dev" });
    expect(scan.unity).toEqual({ detected: true, version: "6000.0.23f1", projectPath: "", note: null });
    expect(scan.docs.map((d) => d.path)).toEqual(["README.md", "docs/gdd.md"]);
    expect(scan.monetization).toMatchObject({ checked: true, admob: false });
    // no CI/workflow data is read any more
    expect(calls.some((c) => c.includes("/actions/") || c.includes(".github/workflows"))).toBe(false);
    // read-only: no write calls other than the token exchange
    expect(calls.filter((c) => !c.startsWith("GET") && !c.includes("access_tokens"))).toEqual([]);
  });

  it("reports missing capabilities instead of assuming them", async () => {
    fakeGitHub({});
    // Same repo but without Unity files / workflows
    const original = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const p = new URL(typeof input === "string" ? input : input.toString()).pathname;
      if (p === "/repos/studio/mini-one/contents/") return json([{ name: "src", path: "src", type: "dir" }]);
      if (p.endsWith("/git/trees/main")) return json({ tree: [{ path: "src/a.txt", type: "blob" }], truncated: false });
      if (p.endsWith("/contents/.github/workflows")) return json({ message: "Not Found" }, 404);
      if (p.endsWith("/actions/workflows")) return json({ workflows: [] });
      return original(input, init);
    }));
    const scan = await scanRepository(config(), 7, "studio", "mini-one");
    expect(scan.unity).toMatchObject({ detected: false, version: null });
    expect(scan.docs).toEqual([]);
    expect(scan.monetization).toEqual({ checked: false });
  });

  it("throws (so no game can be created) when GitHub does not return the repository", async () => {
    fakeGitHub({}, { repoStatus: 404 });
    await expect(scanRepository(config(), 7, "studio", "mini-one")).rejects.toThrow(/404/);
  });
});
