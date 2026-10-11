import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { memdb } from "./memdb";

const h = vi.hoisted(() => ({
  db: null as any, user: { id: "u1", email: "dev@studio.test" } as { id: string; email: string } | null,
  dispatch: vi.fn(async () => undefined), redirect: vi.fn(async (): Promise<string | null> => "https://blob.example/signed?sig=abc"), sync: vi.fn(async () => 0),
}));
vi.mock("@/lib/supabase/server", () => ({
  requireUser: async () => { if (!h.user) throw new Error("redirect"); return { supabase: h.db, user: h.user }; },
  createClient: async () => ({ ...h.db, auth: { getUser: async () => ({ data: { user: h.user } }) } }),
}));
vi.mock("@/lib/github/dispatch", () => ({ dispatchWorkflow: h.dispatch }));
vi.mock("@/lib/github/config", () => ({ requireGitHubConfig: () => ({ appId: "1", slug: null, privateKey: "k" }) }));
vi.mock("@/lib/github/app", () => ({ getInstallationToken: async () => "tok", ghRedirectLocation: h.redirect }));
vi.mock("@/lib/github/scan", () => ({ latestRun: async () => null }));
vi.mock("@/lib/game-sync", () => ({ syncBuilds: h.sync }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const game = { id: "g1", name: "Example Runner", owner: "o", repo: "r", github_installation_id: 7, default_branch: "main", is_archived: false };
const ciWf = { id: "w1", game_id: "g1", github_workflow_id: 11, name: "Unity CI", path: ".github/workflows/unity-ci.yml", kinds: ["test", "build"], dispatchable: true, has_required_inputs: false,
  ci_ref: "o/unity-ci/.github/workflows/unity-ci.yml@main", ci_actions: ["smoke", "test-editmode", "android-dev", "android-release"] };
const plainWf = { id: "w2", game_id: "g1", github_workflow_id: 12, name: "Deploy", path: ".github/workflows/deploy.yml", kinds: ["publish"], dispatchable: true, has_required_inputs: false, ci_ref: null, ci_actions: [] };
const audit = () => h.db.from("workflow_dispatches").select().then((r: any) => r.data);

beforeEach(() => {
  process.env.UNITY_AUTOMATION_ALLOWED = "true";
  h.user = { id: "u1", email: "dev@studio.test" }; h.dispatch.mockClear(); h.sync.mockClear();
  h.db = memdb({ games: [{ ...game }], game_workflows: [{ ...ciWf }, { ...plainWf }, { ...ciWf, id: "w3", has_required_inputs: true, ci_ref: null }], workflow_dispatches: [],
    build_runs: [{ id: "r1", game_id: "g1", artifacts: [{ id: 501, name: "android-dev-1", size_bytes: 1, expired: false }, { id: 502, name: "old", size_bytes: 1, expired: true }] }] });
  vi.stubGlobal("setTimeout", (fn: () => void) => { fn(); return 0 as never; });
});

describe("triggerWorkflowAction (shared CI)", () => {
  it("dispatches an allowed action on the default branch with ONLY the action input, and audits it", async () => {
    const { triggerWorkflowAction } = await import("@/app/(portal)/releases/actions");
    expect(await triggerWorkflowAction({ workflowRowId: "w1", confirmed: true, action: "test-editmode" })).toEqual({ ok: true });
    expect(h.dispatch).toHaveBeenCalledWith(expect.anything(), 7, "o", "r", 11, "main", { action: "test-editmode" });
    expect((await audit())[0]).toMatchObject({ outcome: "accepted", detail: "action=test-editmode", user_email: "dev@studio.test", ref: "main" });
    expect(h.sync).toHaveBeenCalled(); // the queued run shows up immediately
  });
  it("needs explicit confirmation", async () => {
    const { triggerWorkflowAction } = await import("@/app/(portal)/releases/actions");
    expect(await triggerWorkflowAction({ workflowRowId: "w1", confirmed: false as never, action: "test-editmode" })).toMatchObject({ ok: false, error: /Confirmation/ });
    expect(h.dispatch).not.toHaveBeenCalled();
  });
  it("rejects actions the workflow does not declare, unknown strings and a missing action", async () => {
    const { triggerWorkflowAction } = await import("@/app/(portal)/releases/actions");
    for (const action of ["ios-validate", "rm -rf /", "", undefined]) {
      const r = await triggerWorkflowAction({ workflowRowId: "w1", confirmed: true, action: action as string });
      expect(r).toMatchObject({ ok: false, error: /supports/ });
    }
    expect(h.dispatch).not.toHaveBeenCalled();
    expect((await audit()).every((a: any) => a.outcome === "rejected")).toBe(true);
  });
  it("release builds need the game name typed", async () => {
    const { triggerWorkflowAction } = await import("@/app/(portal)/releases/actions");
    expect(await triggerWorkflowAction({ workflowRowId: "w1", confirmed: true, action: "android-release" })).toMatchObject({ ok: false, error: /Type the game name/ });
    expect(await triggerWorkflowAction({ workflowRowId: "w1", confirmed: true, action: "android-release", typedGameName: "example runner" })).toMatchObject({ ok: false });
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(await triggerWorkflowAction({ workflowRowId: "w1", confirmed: true, action: "android-release", typedGameName: "Example Runner" })).toEqual({ ok: true });
    expect(h.dispatch).toHaveBeenCalledWith(expect.anything(), 7, "o", "r", 11, "main", { action: "android-release" });
  });
  it("keeps the older rules for non-shared workflows (publishing needs the name, required inputs are refused) and archived repos", async () => {
    const { triggerWorkflowAction } = await import("@/app/(portal)/releases/actions");
    expect(await triggerWorkflowAction({ workflowRowId: "w2", confirmed: true })).toMatchObject({ ok: false, error: /publishes to a store/ });
    expect(await triggerWorkflowAction({ workflowRowId: "w3", confirmed: true })).toMatchObject({ ok: false, error: /requires inputs/ });
    await h.db.from("games").update({ is_archived: true }).eq("id", "g1");
    expect(await triggerWorkflowAction({ workflowRowId: "w1", confirmed: true, action: "smoke" })).toMatchObject({ ok: false, error: /archived/ });
    expect(h.dispatch).not.toHaveBeenCalled();
  });
});

describe("Unity automation gate", () => {
  it("is OFF by default: every Unity action is refused server-side, the self-test still runs", async () => {
    delete process.env.UNITY_AUTOMATION_ALLOWED;
    const { triggerWorkflowAction } = await import("@/app/(portal)/releases/actions");
    for (const action of ["test-editmode", "android-dev", "android-release"]) {
      const r = await triggerWorkflowAction({ workflowRowId: "w1", confirmed: true, action, typedGameName: "Example Runner" });
      expect(r).toMatchObject({ ok: false, error: /switched off until the Unity licence question/ });
    }
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(await triggerWorkflowAction({ workflowRowId: "w1", confirmed: true, action: "smoke" })).toEqual({ ok: true });
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    process.env.UNITY_AUTOMATION_ALLOWED = "yes"; // only the exact value "true" enables it
    expect((await triggerWorkflowAction({ workflowRowId: "w1", confirmed: true, action: "test-editmode" })).ok).toBe(false);
  });
});

describe("artifact download route", () => {
  const call = async (artifactId: string, gameId = "11111111-1111-4111-8111-111111111111") => {
    h.db = memdb({ games: [{ ...game, id: gameId }], build_runs: [{ id: "r1", game_id: gameId, artifacts: [{ id: 501, name: "a", size_bytes: 1, expired: false }, { id: 502, name: "old", size_bytes: 1, expired: true }] }] });
    const { GET } = await import("@/app/api/artifacts/[gameId]/[artifactId]/route");
    return GET(new NextRequest("http://localhost:3000/x"), { params: Promise.resolve({ gameId, artifactId }) });
  };
  it("redirects to GitHub's short-lived signed URL, never caching or leaking the referrer", async () => {
    const res = await call("501");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://blob.example/signed?sig=abc");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(h.redirect).toHaveBeenCalledWith("tok", "/repos/o/r/actions/artifacts/501/zip");
  });
  it("serves only artifacts the portal recorded for THIS game, and not expired ones", async () => {
    h.redirect.mockClear();
    expect((await call("999")).status).toBe(404);   // an id from another repo
    expect((await call("502")).status).toBe(404);   // expired
    expect((await call("501abc")).status).toBe(400); // malformed
    expect(h.redirect).not.toHaveBeenCalled();
  });
  it("requires a session and reports GitHub-side expiry", async () => {
    h.user = null;
    expect((await call("501")).status).toBe(401);
    h.user = { id: "u1", email: "x" }; h.redirect.mockResolvedValueOnce(null);
    expect((await call("501")).status).toBe(410);
  });
});
