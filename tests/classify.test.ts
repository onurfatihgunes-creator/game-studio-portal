import { describe, expect, it } from "vitest";
import { classifyWorkflow, detectMonetization, docKind, parseUnityVersion } from "@/lib/github/classify";

const BUILD_YML = `
name: Build
on:
  push: { branches: [main] }
  workflow_dispatch:
jobs:
  build:
    strategy:
      matrix:
        targetPlatform: [Android, iOS, WebGL]
    steps:
      - uses: game-ci/unity-builder@v4
        with:
          targetPlatform: \${{ matrix.targetPlatform }}
`;

describe("classifyWorkflow", () => {
  it("detects build workflow, platforms and workflow_dispatch", () => {
    const c = classifyWorkflow(BUILD_YML);
    expect(c.kinds).toEqual(["build"]);
    expect(c.platforms).toEqual(["android", "ios"]);
    expect(c.hasWorkflowDispatch).toBe(true);
    expect(c.triggers).toEqual(["push", "workflow_dispatch"]);
    expect(c.signals.join()).toContain("game-ci/unity-builder");
  });

  it("detects test workflows and does not attach platforms to them", () => {
    const c = classifyWorkflow(`
name: Tests
on: [push, pull_request]
jobs:
  t:
    steps:
      - uses: game-ci/unity-test-runner@v4
        with: { testMode: all, targetPlatform: Android }
`);
    expect(c.kinds).toEqual(["test"]);
    expect(c.platforms).toEqual([]);
    expect(c.hasWorkflowDispatch).toBe(false);
  });

  it("detects publishing workflows", () => {
    const c = classifyWorkflow(`
on: workflow_dispatch
jobs:
  p:
    steps:
      - uses: r0adkll/upload-google-play@v1
`);
    expect(c.kinds).toEqual(["publish"]);
    expect(c.hasWorkflowDispatch).toBe(true);
  });

  it("flags required inputs without defaults", () => {
    const c = classifyWorkflow(`
on:
  workflow_dispatch:
    inputs:
      version: { required: true }
jobs: {}
`);
    expect(c.hasRequiredInputs).toBe(true);
    const ok = classifyWorkflow(`
on:
  workflow_dispatch:
    inputs:
      version: { required: true, default: "1" }
jobs: {}
`);
    expect(ok.hasRequiredInputs).toBe(false);
  });

  it("never guesses: an unrelated workflow has no kinds", () => {
    const c = classifyWorkflow(`
name: Lint
on: push
jobs:
  l:
    steps:
      - run: npm run lint
`);
    expect(c.kinds).toEqual([]);
    expect(c.platforms).toEqual([]);
  });

  it("survives invalid YAML", () => {
    const c = classifyWorkflow("::: not yaml : [\n game-ci/unity-builder");
    expect(c.kinds).toEqual(["build"]);
    expect(c.triggers).toEqual([]);
  });
});

describe("Unity helpers", () => {
  it("parses ProjectVersion.txt", () => {
    expect(parseUnityVersion("m_EditorVersion: 2022.3.20f1\nm_EditorVersionWithRevision: 2022.3.20f1 (abc)")).toBe("2022.3.20f1");
    expect(parseUnityVersion("garbage")).toBeNull();
  });

  it("detects monetization SDKs from the manifest", () => {
    const m = detectMonetization(JSON.stringify({
      dependencies: { "com.unity.purchasing": "4.9.0", "com.google.ads.mobile": "9.0.0", "com.unity.ugui": "1.0.0" },
    }));
    expect(m).toMatchObject({ checked: true, admob: true, iap: true, other_ads: [] });
    expect(detectMonetization(JSON.stringify({ dependencies: { "com.unity.ugui": "1" } }))).toMatchObject({ checked: true, admob: false, iap: false });
    expect(detectMonetization(null)).toEqual({ checked: false });
    expect(detectMonetization("{bad")).toEqual({ checked: false });
  });

  it("classifies docs", () => {
    expect(docKind("README.md")).toBe("readme");
    expect(docKind("CLAUDE.md")).toBe("agent-guide");
    expect(docKind("GDD.md")).toBe("design");
    expect(docKind("Assets/foo.cs")).toBeNull();
  });
});
