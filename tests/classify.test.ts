import { describe, expect, it } from "vitest";
import { detectMonetization, docKind, parseUnityVersion } from "@/lib/github/classify";

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
