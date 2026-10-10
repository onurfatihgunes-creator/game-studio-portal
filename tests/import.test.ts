import { generateKeyPairSync } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { isSameOrigin } from "@/lib/api";
import { addGame, parseRepoRef } from "@/lib/game-sync";
import { DuplicateGameError, insertGame } from "@/lib/games";
import { quickUnityCheck, scanRepository } from "@/lib/github/scan";
import type { ScanResult } from "@/lib/github/types";

vi.mock("@/lib/github/scan", async (orig) => ({ ...(await orig<typeof import("@/lib/github/scan")>()), scanRepository: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [], set: () => {} }) }));

let pem: string;
beforeAll(() => {
  pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:1";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  process.env.GITHUB_APP_ID = "1";
  process.env.GITHUB_APP_PRIVATE_KEY = pem;
});
afterEach(() => vi.unstubAllGlobals());

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const cfg = () => ({ appId: "1", slug: null, privateKey: pem });

function stubRoot(root: unknown, status = 200) {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const p = new URL(typeof input === "string" ? input : input.toString()).pathname;
    if (p.endsWith("/access_tokens")) return json({ token: "t", expires_at: new Date(Date.now() + 3.6e6).toISOString() });
    return json(root, status);
  }));
}

describe("quickUnityCheck (bulk discovery)", () => {
  it("is true only for a ProjectSettings directory at the root", async () => {
    stubRoot([{ name: "Assets", path: "Assets", type: "dir" }, { name: "ProjectSettings", path: "ProjectSettings", type: "dir" }]);
    expect(await quickUnityCheck(cfg(), 501, "o", "unity-repo")).toBe(true);
  });
  it("is false for a file named ProjectSettings, other repos, and empty repos", async () => {
    stubRoot([{ name: "ProjectSettings", path: "ProjectSettings", type: "file" }]);
    expect(await quickUnityCheck(cfg(), 502, "o", "a")).toBe(false);
    stubRoot([{ name: "package.json", path: "package.json", type: "file" }]);
    expect(await quickUnityCheck(cfg(), 502, "o", "b")).toBe(false);
    stubRoot({ message: "Not Found" }, 404);
    expect(await quickUnityCheck(cfg(), 502, "o", "c")).toBe(false);
  });
  it("surfaces real API failures instead of guessing", async () => {
    stubRoot({ message: "Resource not accessible by integration" }, 403);
    await expect(quickUnityCheck(cfg(), 503, "o", "d")).rejects.toThrow(/403/);
  });
});

describe("input validation", () => {
  it("rejects malformed repository references", () => {
    expect(parseRepoRef(1, "owner", "repo-1")).toMatchObject({ id: 1 });
    expect(() => parseRepoRef(0, "o", "r")).toThrow();
    expect(() => parseRepoRef(1, "o/../x", "r")).toThrow();
    expect(() => parseRepoRef(1, "o", "r?x=1")).toThrow();
    expect(() => parseRepoRef("abc", "o", "r")).toThrow();
  });
  it("same-origin check", () => {
    expect(isSameOrigin("http://localhost:3000", "localhost:3000")).toBe(true);
    expect(isSameOrigin("https://evil.example", "localhost:3000")).toBe(false);
    expect(isSameOrigin(null, "localhost:3000")).toBe(false);
    expect(isSameOrigin("not a url", "localhost:3000")).toBe(false);
  });
});

describe("duplicate prevention", () => {
  const scan = {
    scannedAt: new Date().toISOString(),
    repo: { id: 9, installationId: 1, owner: "o", name: "r", fullName: "o/r", htmlUrl: "u", description: null, defaultBranch: "main", isPrivate: true, isArchived: false, pushedAt: null },
    latestCommit: null, unity: { detected: true, version: "6000.0.0f1", projectPath: "", note: null }, docs: [], monetization: { checked: false }, workflows: [],
  } satisfies ScanResult;

  it("maps the unique-violation on github_repo_id to DuplicateGameError", async () => {
    const db: any = { from: () => ({ insert: () => ({ select: () => ({ single: async () => ({ data: null, error: { code: "23505", message: "duplicate key" } }) }) }) }) };
    await expect(insertGame(db, scan, { name: "R", type: "mini", devStatus: "prototype" })).rejects.toBeInstanceOf(DuplicateGameError);
  });
  it("does not swallow other database errors", async () => {
    const db: any = { from: () => ({ insert: () => ({ select: () => ({ single: async () => ({ data: null, error: { code: "42501", message: "denied" } }) }) }) }) };
    await expect(insertGame(db, scan, { name: "R", type: "mini", devStatus: "prototype" })).rejects.toThrow(/denied/);
  });
});

const ROUTES = {
  import: () => import("@/app/api/games/import/route"),
  discover: () => import("@/app/api/games/discover/route"),
  refresh: () => import("@/app/api/games/refresh/route"),
};

describe("/api/games routes are protected", () => {
  const req = (path: string, headers: Record<string, string>) =>
    new NextRequest(`http://localhost:3000${path}`, { method: "POST", headers: { host: "localhost:3000", ...headers }, body: "{}" });

  for (const route of ["import", "discover", "refresh"] as const) {
    it(`${route}: rejects cross-origin, non-JSON and unauthenticated calls`, async () => {
      const { POST } = await ROUTES[route]();
      const status = async (headers: Record<string, string>) => (await POST(req(`/api/games/${route}`, headers)))?.status;
      expect(await status({ "content-type": "application/json" })).toBe(403); // no Origin
      expect(await status({ origin: "https://evil.example", "content-type": "application/json" })).toBe(403);
      expect(await status({ origin: "http://localhost:3000", "content-type": "text/plain" })).toBe(415);
      expect(await status({ origin: "http://localhost:3000", "content-type": "application/json" })).toBe(401); // no session
    });
  }
});

describe("bulk import guard (requireUnity)", () => {
  const scanOf = (detected: boolean) => ({
    scannedAt: new Date().toISOString(),
    repo: { id: 77, installationId: 1, owner: "o", name: "unity-merge-engine", fullName: "o/unity-merge-engine", htmlUrl: "u", description: null, defaultBranch: "main", isPrivate: true, isArchived: false, pushedAt: null },
    latestCommit: null, unity: { detected, version: detected ? "6000.0.0f1" : null, projectPath: detected ? "" : null, note: null },
    docs: [], monetization: { checked: false }, workflows: [],
  }) satisfies ScanResult;
  const input = { installationId: 1, owner: "o", repo: "unity-merge-engine", name: "Engine", type: "mini", devStatus: "prototype", requireUnity: true } as const;
  const untouchedDb: any = { from: () => { throw new Error("database must not be touched"); } };

  it("refuses a repository with no Unity project and writes nothing", async () => {
    vi.mocked(scanRepository).mockResolvedValueOnce(scanOf(false));
    await expect(addGame(untouchedDb, input)).rejects.toThrow(/No Unity project found/);
  });
  it("the single-game wizard path stays permissive (no requireUnity)", async () => {
    vi.mocked(scanRepository).mockResolvedValueOnce(scanOf(false));
    const db: any = { from: () => ({ insert: () => ({ select: () => ({ single: async () => ({ data: { id: "new" }, error: null }) }) }), delete: () => ({ eq: async () => ({ error: null }) }) }) };
    await expect(addGame(db, { ...input, requireUnity: false })).resolves.toBe("new");
  });
  it("accepts a confirmed Unity project", async () => {
    vi.mocked(scanRepository).mockResolvedValueOnce(scanOf(true));
    const db: any = { from: () => ({ insert: () => ({ select: () => ({ single: async () => ({ data: { id: "ok" }, error: null }) }) }), delete: () => ({ eq: async () => ({ error: null }) }) }) };
    await expect(addGame(db, input)).resolves.toBe("ok");
  });
});
