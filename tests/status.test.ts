import { describe, expect, it } from "vitest";
import { monetizationSummary } from "@/lib/status";
import type { GameRow } from "@/lib/types";

const g = (m: object, unity = true) => ({ unity_detected: unity, monetization: m }) as unknown as GameRow;

describe("monetization summary", () => {
  it("is unknown without evidence, never assumed", () => {
    expect(monetizationSummary(g({ checked: false })).state).toBe("unknown");
    expect(monetizationSummary(g({ checked: true }, false)).state).toBe("unknown");
  });
  it("reports nothing found as not_configured", () => {
    expect(monetizationSummary(g({ checked: true, admob: false })).state).toBe("not_configured");
  });
  it("lists what the repository contains", () => {
    const s = monetizationSummary(g({ checked: true, admob: true, studio_ads: { module_version: "0.3.1", config_file: true }, other_ads: ["AppLovin"] }));
    expect(s).toEqual({ state: "detected", items: ["AdMob SDK", "Studio ads module", "AppLovin"] });
  });
});
