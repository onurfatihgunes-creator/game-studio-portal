import { describe, expect, it } from "vitest";
import { createCandidate, decideRelease } from "@/lib/releases";
import { memdb, type Row } from "./memdb";

const HEAD = "aaaaaaa1111111";
const game: Row = { id: "g1", name: "Example Runner", commit_sha: HEAD, is_archived: false,
  project_facts: { checked: true, companyName: "Acme", androidBundleId: "com.acme.rr", iosBundleId: "com.acme.rr", version: "1.0", androidVersionCode: 1, androidTargetSdk: 35, iosBuildNumber: "1", appleTeamId: "T" } };
const run = (id: string, action: string, over: Row = {}): Row => ({ id, game_id: "g1", action, status: "completed", conclusion: "success", head_sha: HEAD, started_at: "2026-10-10T10:00:00Z",
  version: "1.0.1", build_number: 2, artifacts: [{ id: 77, name: `${action}-1`, size_bytes: 3e7, expired: false, expires_at: null }], failed_step: null, ...over });
const actor = { id: "u1", email: "dev@studio.test" };

function setup(runs: Row[], releases: Row[] = []) {
  return memdb({ games: [game], build_runs: runs, game_releases: releases, __unique: [{ table: "game_releases", cols: ["game_id", "platform", "version", "build_number"] }] });
}

describe("createCandidate", () => {
  it("records a candidate from a successful build with the readiness snapshot, publishing nothing", async () => {
    const db = setup([run("r1", "android-release"), run("t1", "test-editmode")]);
    const id = await createCandidate(db, { gameId: "g1", runId: "r1", platform: "android" });
    const rel = (await db.from("game_releases").select().eq("id", id).maybeSingle()).data;
    expect(rel.status ?? "candidate").toBe("candidate"); // the table default; the code never sets approval
    expect(rel).toMatchObject({ platform: "android", version: "1.0.1", build_number: 2, artifact_id: 77, head_sha: HEAD });
    expect(rel.readiness.checks.length).toBeGreaterThan(3);
  });
  it("refuses wrong-platform runs, failed runs, and unknown versions", async () => {
    const db = setup([run("r1", "android-dev"), run("bad", "android-release", { conclusion: "failure" }), run("nov", "android-release", { version: null, build_number: null })]);
    await expect(createCandidate(db, { gameId: "g1", runId: "r1", platform: "ios" })).rejects.toThrow(/must come from/);
    await expect(createCandidate(db, { gameId: "g1", runId: "bad", platform: "android" })).rejects.toThrow(/successful/);
    // version falls back to the project's facts when the run has none
    await expect(createCandidate(db, { gameId: "g1", runId: "nov", platform: "android" })).resolves.toBeTruthy();
    await expect(createCandidate(db, { gameId: "g1", runId: "missing", platform: "android" })).rejects.toThrow(/not found/);
  });
  it("prevents duplicate candidates for the same version and build number", async () => {
    const db = setup([run("r1", "android-release")]);
    await createCandidate(db, { gameId: "g1", runId: "r1", platform: "android" });
    await expect(createCandidate(db, { gameId: "g1", runId: "r1", platform: "android" })).rejects.toThrow(/already exists/);
  });
});

describe("decideRelease", () => {
  const candidate = (over: Row = {}): Row => ({ id: "rel1", game_id: "g1", platform: "android", version: "1.0.1", build_number: 2, build_run_id: "r1", status: "candidate", readiness: { checks: [], blockers: 0 }, notes: null, ...over });
  const green = () => [run("r1", "android-release"), run("t1", "test-editmode"), run("t2", "test-playmode")];

  it("approves a fully ready candidate after typed confirmation, recording who and when", async () => {
    const db = setup(green(), [candidate()]);
    await decideRelease(db, { releaseId: "rel1", decision: "approve", typedName: "Example Runner" }, actor);
    const r = (await db.from("game_releases").select().eq("id", "rel1").maybeSingle()).data;
    expect(r).toMatchObject({ status: "approved", decided_by: "u1", decided_by_email: "dev@studio.test" });
    expect(r.decided_at).toBeTruthy();
  });
  it("requires the exact game name", async () => {
    const db = setup(green(), [candidate()]);
    await expect(decideRelease(db, { releaseId: "rel1", decision: "approve", typedName: "example runner" }, actor)).rejects.toThrow(/Type the game name/);
  });
  it("refuses to approve while any check fails (debug-signed dev build, placeholder id, ...)", async () => {
    const dev = [run("r1", "android-dev"), run("t1", "test-editmode")];
    const db = setup(dev, [candidate()]);
    await expect(decideRelease(db, { releaseId: "rel1", decision: "approve", typedName: "Example Runner" }, actor)).rejects.toThrow(/Not approvable.*release-signed/);
    expect((await db.from("game_releases").select().eq("id", "rel1").maybeSingle()).data.status).toBe("candidate");
  });
  it("only approved releases can be marked published manually; final states are final", async () => {
    const db = setup(green(), [candidate()]);
    await expect(decideRelease(db, { releaseId: "rel1", decision: "published_manually", typedName: "Example Runner" }, actor)).rejects.toThrow(/Only an approved/);
    await decideRelease(db, { releaseId: "rel1", decision: "approve", typedName: "Example Runner" }, actor);
    await decideRelease(db, { releaseId: "rel1", decision: "published_manually", typedName: "Example Runner" }, actor);
    await expect(decideRelease(db, { releaseId: "rel1", decision: "reject", typedName: "Example Runner" }, actor)).rejects.toThrow(/already final/);
  });
  it("a later candidate must beat the approved build number", async () => {
    const approved = candidate({ id: "old", status: "approved", build_number: 2, version: "1.0.1" });
    const db = setup(green(), [approved, candidate({ id: "rel2", build_run_id: "r1", build_number: 2, version: "1.0.2" })]);
    await expect(decideRelease(db, { releaseId: "rel2", decision: "approve", typedName: "Example Runner" }, actor)).rejects.toThrow(/Build number|build number/i);
  });
});
