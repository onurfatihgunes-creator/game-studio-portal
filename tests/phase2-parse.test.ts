import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyWorkflow } from "@/lib/github/classify";
import { parseProjectSettings } from "@/lib/github/project-facts";
import { actionFromTitle, isCiAction, knownActions } from "@/lib/ci/actions";

describe("parseProjectSettings", () => {
  const facts = parseProjectSettings(readFileSync("tests/fixtures/ProjectSettings.sample.asset", "utf8"));
  it("reads identity, ids and versions", () => {
    expect(facts).toMatchObject({
      checked: true, companyName: "ExampleCo", productName: "Example Game", version: "1.0",
      androidBundleId: "com.example.game", iosBundleId: "com.example.game", androidVersionCode: 1, iosBuildNumber: "0",
      androidMinSdk: 26, androidTargetSdk: 0, iosMinOs: "15.0", androidScriptingBackend: "il2cpp", iosScriptingBackend: "il2cpp",
    });
  });
  it("treats empty values as null and a debug keystore as not custom", () => {
    expect(facts.appleTeamId).toBeNull();
    expect(facts.androidCustomKeystore).toBe(false);
  });
  it("never guesses on unreadable input", () => {
    expect(parseProjectSettings(null)).toEqual({ checked: false });
    expect(parseProjectSettings("not unity")).toEqual({ checked: false });
    const partial = parseProjectSettings("PlayerSettings:\n  productName: X\n");
    expect(partial).toMatchObject({ checked: true, productName: "X", androidBundleId: null, androidVersionCode: null });
  });
});

describe("CI action vocabulary", () => {
  it("only trusts known actions", () => {
    expect(isCiAction("android-dev")).toBe(true);
    expect(isCiAction("rm -rf")).toBe(false);
    expect(knownActions(["test-editmode", "bogus", "ios-validate"])).toEqual(["test-editmode", "ios-validate"]);
    expect(actionFromTitle(" android-dev ")).toBe("android-dev");
    expect(actionFromTitle("Fix typo")).toBeNull();
  });
});

describe("shared-CI caller detection", () => {
  const caller = (ref: string) => `
name: Unity CI
run-name: \${{ inputs.action }}
on:
  workflow_dispatch:
    inputs:
      action:
        type: choice
        required: true
        default: test-editmode
        options: [smoke, test-editmode, test-playmode, android-dev, ios-validate, hacked]
permissions:
  contents: read
jobs:
  ci:
    uses: ${ref}
    with:
      action: \${{ inputs.action }}
`;
  it("recognises the studio's shared workflow and derives kinds/platforms from the declared actions", () => {
    const c = classifyWorkflow(caller("someone/unity-ci/.github/workflows/unity-ci.yml@v1"));
    expect(c.ciRef).toBe("someone/unity-ci/.github/workflows/unity-ci.yml@v1");
    expect(c.ciActions).toEqual(["smoke", "test-editmode", "test-playmode", "android-dev", "ios-validate"]); // "hacked" dropped
    expect(c.kinds).toEqual(["test", "build"]);
    expect(c.platforms).toEqual(["android", "ios"]);
    expect(c.hasWorkflowDispatch).toBe(true);
    expect(c.hasRequiredInputs).toBe(false); // the action input has a default
  });
  it("ignores look-alike or unrelated reusable workflows", () => {
    expect(classifyWorkflow(caller("someone/other-repo/.github/workflows/unity-ci.yml@v1")).ciRef).toBeNull();
    expect(classifyWorkflow(caller("someone/unity-ci-fork/.github/workflows/x.yml@v1")).ciRef).toBeNull();
  });
});
